import {
  Prisma,
  type CollectionPolicy,
  type CollectionPolicyStep,
  type CollectionSequence,
  type CollectionStopReason,
} from "@prisma/client";

import { approveActionProposal } from "@/server/operator/approval";
import { ensureInsightForInvoiceOverdueEvent } from "@/server/operator/insights";
import { ensureReminderProposalForInsight } from "@/server/operator/proposals";
import { prepareReminderCommunication, type AiOverride } from "@/server/communications/draft";
import { sendCommunication } from "@/server/communications/send";
import { recordActivityEvent } from "@/server/ar/activity";
import { daysBetween, toDateOnlyString } from "@/server/ar/dates";
import { getInvoiceWithFinancials, listInvoicesWithFinancials } from "@/server/ar/invoices";
import { buildDeterministicInvoiceContext } from "@/server/ar/reminder-context";
import { prisma } from "@/server/db/client";
import type { EmailProvider } from "@/server/email/types";
import type { MessagingProvider } from "@/server/messaging/types";
import { env } from "@/lib/env";
import { enrollEligibleInvoices } from "./enrollment";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

export type AutomationTickSummary = {
  globallyDisabled: boolean;
  organizationsProcessed: number;
  // Phase 9 (docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-5): how many
  // automation-enabled organizations were NOT processed this invocation
  // because they didn't fit in this call's batch — 0 means the batch
  // covered every eligible organization. Not "lost" work: the next
  // invocation picks up the least-recently-processed organizations first
  // (Organization.automationLastTickAt), so this is a queue depth, not a
  // skip count.
  organizationsRemaining: number;
  scanned: number;
  enrolled: number;
  claimed: number;
  executed: number;
  skipped: number;
  stopped: number;
  blocked: number;
  failed: number;
};

function emptySummary(globallyDisabled: boolean): AutomationTickSummary {
  return {
    globallyDisabled,
    organizationsProcessed: 0,
    organizationsRemaining: 0,
    scanned: 0,
    enrolled: 0,
    claimed: 0,
    executed: 0,
    skipped: 0,
    stopped: 0,
    blocked: 0,
    failed: 0,
  };
}

/**
 * Schedule ≠ permission to send — see docs/collections-automation.md
 * #safety-principle. This is the single entrypoint every scheduling
 * mechanism (the internal HTTP tick endpoint, a dev-only manual trigger)
 * calls; it never sends anything by virtue of being invoked; every action
 * it takes is re-verified against fresh state immediately beforehand.
 *
 * `now` is the one non-deterministic input, always explicit: production
 * callers pass `new Date()`, tests inject a fixed value — see
 * docs/collections-automation.md#scheduling for why nothing downstream of
 * this function ever reads the real clock itself (buildDeterministicInvoiceContext/
 * getInvoiceWithFinancials/listInvoicesWithFinancials all accept the
 * derived `today` string threaded through from here).
 *
 * `options.globalEnabled` defaults to the deployment-level
 * AUTOMATION_ENABLED env flag but is overridable in tests (the flag is a
 * load-time singleton — see src/lib/env.ts — so this is the same
 * dependency-injection escape hatch `now` is, applied to a second
 * non-deterministic/environmental input).
 *
 * Phase 9 bounded-batch model (docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md
 * P1-5): a global tick (no `options.organizationId`) processes at most
 * `options.batchSize` (default `AUTOMATION_BATCH_SIZE`) organizations,
 * least-recently-processed first (`Organization.automationLastTickAt`,
 * updated after every org this invocation touches, success or failure).
 * This makes one invocation's work bounded and finite regardless of how
 * many organizations exist — the *next* invocation picks up where this
 * one left off, fairly, without any request/response cursor token to
 * lose. One organization's own unexpected exception (e.g. a malformed
 * policy blowing up the bulk fetch, not just a single sequence's
 * processing) is caught per-organization so it can never abort the rest
 * of the batch — see the try/catch inside the loop below, a level above
 * `processOrganizationTick`'s existing per-*sequence* isolation.
 *
 * Every invocation persists one `AutomationTickRun` row — a durable
 * heartbeat `src/server/collections/health.ts` reads from, so "is
 * automation actually running" is answerable from the database, not from
 * whoever happens to be watching a log stream.
 */
export async function runAutomationTick(
  now: Date = new Date(),
  options: {
    organizationId?: string;
    globalEnabled?: boolean;
    batchSize?: number;
    emailProvider?: EmailProvider;
    messagingProvider?: MessagingProvider;
    aiOverride?: AiOverride;
  } = {},
): Promise<AutomationTickSummary> {
  const wallClockStartedAt = new Date();
  const startedAt = Date.now();
  const globalEnabled = options.globalEnabled ?? env.AUTOMATION_ENABLED;
  if (!globalEnabled) {
    const summary = emptySummary(true);
    logTickSummary(options.organizationId, summary, Date.now() - startedAt);
    await persistTickRun(wallClockStartedAt, Date.now() - startedAt, summary, false, null);
    return summary;
  }

  const today = toDateOnlyString(now);
  const summary = emptySummary(false);

  try {
    const batchSize = options.batchSize ?? env.AUTOMATION_BATCH_SIZE;
    const { ids: targetOrganizationIds, totalEligible } = await resolveTargetOrganizations(
      options.organizationId,
      batchSize,
    );
    summary.organizationsRemaining = Math.max(0, totalEligible - targetOrganizationIds.length);

    for (const organizationId of targetOrganizationIds) {
      summary.organizationsProcessed += 1;
      try {
        const counts = await processOrganizationTick(
          organizationId,
          today,
          options.emailProvider,
          options.messagingProvider,
          options.aiOverride,
        );
        summary.scanned += counts.scanned;
        summary.enrolled += counts.enrolled;
        summary.claimed += counts.claimed;
        summary.executed += counts.executed;
        summary.skipped += counts.skipped;
        summary.stopped += counts.stopped;
        summary.blocked += counts.blocked;
        summary.failed += counts.failed;
      } catch (error) {
        // One organization's bulk-fetch or policy data blowing up must
        // never take the rest of the batch down with it.
        summary.failed += 1;
        logOrganizationFailure(organizationId, error);
      } finally {
        await prisma.organization
          .update({ where: { id: organizationId }, data: { automationLastTickAt: wallClockStartedAt } })
          .catch(() => {
            // Never let cursor bookkeeping itself break the tick.
          });
      }
    }

    logTickSummary(options.organizationId, summary, Date.now() - startedAt);
    await persistTickRun(wallClockStartedAt, Date.now() - startedAt, summary, false, null);
    return summary;
  } catch (error) {
    // A failure here is not one organization's problem — it's the tick
    // infrastructure itself (e.g. the initial organization-selection
    // query failing). Recorded distinctly (`crashed: true`) so a health
    // check can tell "the scheduler ran but some orgs failed" apart from
    // "the scheduler itself broke," then re-thrown so the calling HTTP
    // route still reports failure to whatever's watching it.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[automation] tick crashed organizationId=${options.organizationId ?? "ALL"}: ${message}`);
    await persistTickRun(wallClockStartedAt, Date.now() - startedAt, summary, true, message);
    throw error;
  }
}

async function resolveTargetOrganizations(
  organizationId: string | undefined,
  batchSize: number,
): Promise<{ ids: string[]; totalEligible: number }> {
  if (organizationId) {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, automationEnabled: true },
    });
    const eligible = org?.automationEnabled ? [org.id] : [];
    return { ids: eligible, totalEligible: eligible.length };
  }
  const [batch, totalEligible] = await Promise.all([
    prisma.organization.findMany({
      where: { automationEnabled: true },
      // Least-recently-processed first; a stable `id` tiebreaker keeps
      // ordering deterministic across ties (most commonly many `null`s —
      // organizations never processed yet) rather than letting Postgres
      // reorder them arbitrarily between calls.
      orderBy: [{ automationLastTickAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
      take: batchSize,
      select: { id: true },
    }),
    prisma.organization.count({ where: { automationEnabled: true } }),
  ]);
  return { ids: batch.map((org) => org.id), totalEligible };
}

async function persistTickRun(
  startedAt: Date,
  durationMs: number,
  summary: AutomationTickSummary,
  crashed: boolean,
  errorMessage: string | null,
): Promise<void> {
  await prisma.automationTickRun
    .create({
      data: {
        startedAt,
        completedAt: new Date(),
        durationMs,
        globallyDisabled: summary.globallyDisabled,
        organizationsProcessed: summary.organizationsProcessed,
        organizationsRemaining: summary.organizationsRemaining,
        scanned: summary.scanned,
        enrolled: summary.enrolled,
        claimed: summary.claimed,
        executed: summary.executed,
        skipped: summary.skipped,
        stopped: summary.stopped,
        blocked: summary.blocked,
        failed: summary.failed,
        crashed,
        errorMessage: errorMessage?.slice(0, 2000),
      },
    })
    .catch((error: unknown) => {
      // Telemetry persistence must never be the reason a tick "fails".
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[automation] failed to persist tick run telemetry: ${message}`);
    });
}

type OrgCounts = {
  scanned: number;
  enrolled: number;
  claimed: number;
  executed: number;
  skipped: number;
  stopped: number;
  blocked: number;
  failed: number;
};

function emptyOrgCounts(): OrgCounts {
  return { scanned: 0, enrolled: 0, claimed: 0, executed: 0, skipped: 0, stopped: 0, blocked: 0, failed: 0 };
}

/**
 * Per-organization query strategy is O(1) database round trips relative
 * to invoice/sequence count within the org — bulk-fetches financials,
 * policies, steps, step-executions, and blocking communications once each,
 * then processes every ACTIVE sequence from those in-memory maps. The only
 * per-invoice queries are the two fresh re-checks inside
 * processSequenceTick, and those only run for invoices actually about to
 * receive a new automated action (proportional to actions taken, not to
 * total invoice count). See docs/collections-automation.md#performance for
 * the documented scaling boundary this doesn't yet address (very large
 * single-organization invoice counts within one tick).
 */
async function processOrganizationTick(
  organizationId: string,
  today: string,
  emailProvider?: EmailProvider,
  messagingProvider?: MessagingProvider,
  aiOverride?: AiOverride,
): Promise<OrgCounts> {
  const counts = emptyOrgCounts();

  const activePolicy = await prisma.collectionPolicy.findFirst({
    where: { organizationId, isDefault: true, enabled: true },
  });
  if (activePolicy) {
    const enrolledResults = await enrollEligibleInvoices(
      organizationId,
      activePolicy.id,
      activePolicy.currentVersion,
      today,
    );
    counts.enrolled = enrolledResults.filter((result) => result.created).length;
  }

  const activeSequences = await prisma.collectionSequence.findMany({
    where: { organizationId, status: "ACTIVE" },
  });
  counts.scanned = activeSequences.length;
  if (activeSequences.length === 0) return counts;

  const invoiceIds = activeSequences.map((sequence) => sequence.invoiceId);
  const policyIds = [...new Set(activeSequences.map((sequence) => sequence.policyId))];
  const sequenceIds = activeSequences.map((sequence) => sequence.id);

  const [allInvoices, policies, allSteps, existingExecutions, blockingCommunications] = await Promise.all([
    listInvoicesWithFinancials(organizationId, "all", { today }),
    prisma.collectionPolicy.findMany({ where: { id: { in: policyIds } } }),
    prisma.collectionPolicyStep.findMany({ where: { policyId: { in: policyIds } } }),
    prisma.collectionStepExecution.findMany({ where: { sequenceId: { in: sequenceIds } } }),
    prisma.communication.findMany({
      where: { invoiceId: { in: invoiceIds }, status: { in: ["SENDING", "UNCERTAIN"] } },
      select: { invoiceId: true },
    }),
  ]);

  const financialsByInvoiceId = new Map(allInvoices.map((entry) => [entry.invoice.id, entry]));
  const policyById = new Map(policies.map((policy) => [policy.id, policy]));
  const stepsByVersionKey = new Map<string, CollectionPolicyStep[]>();
  for (const step of allSteps) {
    const key = `${step.policyId}:${step.version}`;
    const list = stepsByVersionKey.get(key) ?? [];
    list.push(step);
    stepsByVersionKey.set(key, list);
  }
  const executedStepIdsBySequence = new Map<string, Set<string>>();
  for (const execution of existingExecutions) {
    const set = executedStepIdsBySequence.get(execution.sequenceId) ?? new Set<string>();
    set.add(execution.stepId);
    executedStepIdsBySequence.set(execution.sequenceId, set);
  }
  const blockedInvoiceIds = new Set(blockingCommunications.map((communication) => communication.invoiceId));

  for (const sequence of activeSequences) {
    try {
      const outcome = await processSequenceTick(sequence, today, {
        financialsEntry: financialsByInvoiceId.get(sequence.invoiceId),
        policy: policyById.get(sequence.policyId),
        steps: stepsByVersionKey.get(`${sequence.policyId}:${sequence.policyVersion}`) ?? [],
        executedStepIds: executedStepIdsBySequence.get(sequence.id) ?? new Set<string>(),
        isBlocked: blockedInvoiceIds.has(sequence.invoiceId),
        emailProvider,
        messagingProvider,
        aiOverride,
      });
      counts.claimed += outcome.claimed;
      counts.executed += outcome.executed;
      counts.skipped += outcome.skipped;
      counts.stopped += outcome.stopped;
      counts.blocked += outcome.blocked;
    } catch (error) {
      counts.failed += 1;
      logSequenceFailure(organizationId, sequence.id, error);
    }
  }

  return counts;
}

type SequenceOutcome = { claimed: number; executed: number; skipped: number; stopped: number; blocked: number };

function emptyOutcome(): SequenceOutcome {
  return { claimed: 0, executed: 0, skipped: 0, stopped: 0, blocked: 0 };
}

type SequenceTickContext = {
  financialsEntry: Awaited<ReturnType<typeof listInvoicesWithFinancials>>[number] | undefined;
  policy: CollectionPolicy | undefined;
  steps: CollectionPolicyStep[];
  executedStepIds: Set<string>;
  isBlocked: boolean;
  emailProvider?: EmailProvider;
  messagingProvider?: MessagingProvider;
  aiOverride?: AiOverride;
};

/**
 * The full eligibility re-check chain for one sequence, re-run from
 * scratch every tick regardless of what a previous tick decided — see
 * docs/collections-automation.md#safety-principle. Order matters: paid ->
 * cancelled -> archived -> policy-disabled -> uncertain-delivery-blocked
 * are all terminal-for-this-tick conditions checked before ever looking at
 * *which* step might be due.
 */
async function processSequenceTick(
  sequence: CollectionSequence,
  today: string,
  ctx: SequenceTickContext,
): Promise<SequenceOutcome> {
  const outcome = emptyOutcome();
  const { financialsEntry, policy, steps, executedStepIds, isBlocked, emailProvider, messagingProvider, aiOverride } = ctx;

  if (!financialsEntry) return outcome;
  const { invoice, financials } = financialsEntry;

  if (financials.isPaid) {
    if (await stopSequence(sequence, "COMPLETED", "PAID")) outcome.stopped = 1;
    return outcome;
  }
  if (invoice.status === "CANCELLED") {
    if (await stopSequence(sequence, "STOPPED", "CANCELLED")) outcome.stopped = 1;
    return outcome;
  }
  if (invoice.customer.archivedAt) {
    if (await stopSequence(sequence, "STOPPED", "CUSTOMER_ARCHIVED")) outcome.stopped = 1;
    return outcome;
  }
  if (!policy || !policy.enabled) {
    if (await stopSequence(sequence, "STOPPED", "POLICY_DISABLED")) outcome.stopped = 1;
    return outcome;
  }
  if (isBlocked) {
    outcome.blocked = 1;
    return outcome;
  }

  const dueDateStr = toDateOnlyString(invoice.dueDate);
  const daysOverdue = daysBetween(dueDateStr, today);
  const { stepToExecute, supersededSteps } = findDueSteps(steps, daysOverdue, executedStepIds);
  if (!stepToExecute) return outcome;

  for (const superseded of supersededSteps) {
    const skipped = await claimStepExecution(
      sequence,
      superseded,
      "SKIPPED",
      "Superseded by a later due step in the same catch-up pass",
    );
    if (skipped) outcome.skipped += 1;
  }

  const claim = await claimStepExecution(sequence, stepToExecute, "CLAIMED", null);
  if (!claim) return outcome; // lost the race to another worker, or a prior tick left a stuck CLAIMED row
  outcome.claimed = 1;

  // Pause↔worker race: the sequence may have been paused/stopped by a
  // human (or a concurrent tick) between the bulk read above and this
  // claim. Re-check the authoritative row, not the in-memory `sequence`.
  const currentSequence = await prisma.collectionSequence.findUniqueOrThrow({ where: { id: sequence.id } });
  if (currentSequence.status !== "ACTIVE") {
    await markStepExecutionSkipped(sequence, claim.id, `Sequence is no longer ACTIVE (${currentSequence.status})`);
    return outcome;
  }

  // Payment/cancellation race (section 12/13): re-fetch authoritative
  // financial state one more time immediately before creating anything,
  // now that a full DB round trip has elapsed since the bulk scan.
  const fresh = await getInvoiceWithFinancials(sequence.organizationId, sequence.invoiceId, today);
  if (fresh.financials.isPaid) {
    await markStepExecutionSkipped(sequence, claim.id, "Invoice paid between claim and execution");
    if (await stopSequence(sequence, "COMPLETED", "PAID")) outcome.stopped = 1;
    return outcome;
  }
  if (fresh.invoice.status === "CANCELLED") {
    await markStepExecutionSkipped(sequence, claim.id, "Invoice cancelled between claim and execution");
    if (await stopSequence(sequence, "STOPPED", "CANCELLED")) outcome.stopped = 1;
    return outcome;
  }

  const { businessEvent, proposal } = await runStepThroughOperator(sequence, stepToExecute, claim.id, today);

  await prisma.collectionStepExecution.update({
    where: { id: claim.id },
    data: { status: "EXECUTED", businessEventId: businessEvent.id, actionProposalId: proposal.id, completedAt: new Date() },
  });
  await recordActivityEvent(prisma, {
    organizationId: sequence.organizationId,
    type: "COLLECTION_STEP_EXECUTED",
    summary: `Collection step executed (day ${stepToExecute.daysAfterDue}, ${stepToExecute.action})`,
    invoiceId: sequence.invoiceId,
    customerId: sequence.customerId,
  });
  outcome.executed = 1;

  if (policy.automationMode === "AUTO_SEND" && policy.autoSendEnabledByUserId) {
    await executeAutoSend(
      sequence,
      proposal.id,
      policy.autoSendEnabledByUserId,
      today,
      emailProvider,
      messagingProvider,
      aiOverride,
    );
  }

  return outcome;
}

/**
 * Pure step-selection logic (section 8's `findDueWork`, at the individual
 * sequence's granularity): every not-yet-executed step whose threshold has
 * passed is a "candidate"; only the single most-advanced one is actually
 * executed, and every earlier candidate is superseded — this is the whole
 * of the catch-up policy (section 25). No I/O, so it's directly unit
 * testable without a database. See docs/collections-automation.md#catch-up.
 */
export function findDueSteps(
  steps: CollectionPolicyStep[],
  daysOverdue: number,
  executedStepIds: Set<string>,
): { stepToExecute: CollectionPolicyStep | null; supersededSteps: CollectionPolicyStep[] } {
  const candidates = steps
    .filter((step) => daysOverdue >= step.daysAfterDue && !executedStepIds.has(step.id))
    .sort((a, b) => a.daysAfterDue - b.daysAfterDue);
  if (candidates.length === 0) return { stepToExecute: null, supersededSteps: [] };
  return { stepToExecute: candidates[candidates.length - 1]!, supersededSteps: candidates.slice(0, -1) };
}

/**
 * The DB-backed worker↔worker invariant: `collection_step_executions` has
 * `@@unique([sequenceId, stepId])`, so this create either wins outright or
 * fails with P2002 — exactly the create-then-catch pattern used throughout
 * Phases 3-4, never a JS mutex or in-memory lock. See
 * docs/collections-automation.md#concurrency.
 */
async function claimStepExecution(
  sequence: CollectionSequence,
  step: CollectionPolicyStep,
  status: "CLAIMED" | "SKIPPED",
  note: string | null,
): Promise<{ id: string } | null> {
  try {
    const execution = await prisma.collectionStepExecution.create({
      data: {
        organizationId: sequence.organizationId,
        sequenceId: sequence.id,
        stepId: step.id,
        status,
        note: note ?? undefined,
        completedAt: status === "SKIPPED" ? new Date() : undefined,
      },
    });
    if (status === "SKIPPED") {
      await recordActivityEvent(prisma, {
        organizationId: sequence.organizationId,
        type: "COLLECTION_STEP_SKIPPED",
        summary: `Collection step skipped (day ${step.daysAfterDue}) — ${note}`,
        invoiceId: sequence.invoiceId,
        customerId: sequence.customerId,
      });
    }
    return execution;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_CONSTRAINT_VIOLATION) {
      return null;
    }
    throw error;
  }
}

async function markStepExecutionSkipped(
  sequence: CollectionSequence,
  executionId: string,
  note: string,
): Promise<void> {
  await prisma.collectionStepExecution.update({
    where: { id: executionId },
    data: { status: "SKIPPED", note, completedAt: new Date() },
  });
  await recordActivityEvent(prisma, {
    organizationId: sequence.organizationId,
    type: "COLLECTION_STEP_SKIPPED",
    summary: `Collection step skipped — ${note}`,
    invoiceId: sequence.invoiceId,
    customerId: sequence.customerId,
  });
}

/** Atomic conditional update — only stops a sequence still ACTIVE, so two concurrent stop attempts never double-fire the audit event. */
async function stopSequence(
  sequence: CollectionSequence,
  status: "COMPLETED" | "STOPPED",
  stopReason: CollectionStopReason,
): Promise<boolean> {
  const now = new Date();
  const result = await prisma.collectionSequence.updateMany({
    where: { id: sequence.id, status: "ACTIVE" },
    data: {
      status,
      stopReason,
      stoppedAt: status === "STOPPED" ? now : undefined,
      completedAt: status === "COMPLETED" ? now : undefined,
    },
  });
  if (result.count !== 1) return false;
  await recordActivityEvent(prisma, {
    organizationId: sequence.organizationId,
    type: "COLLECTION_SEQUENCE_STOPPED",
    summary: `Collections sequence stopped (${stopReason})`,
    invoiceId: sequence.invoiceId,
    customerId: sequence.customerId,
  });
  return true;
}

/**
 * Reuses the existing Phase 3 Operator primitives end to end — no second
 * Operator, no `AutomatedReminderProposal` type (section 19). `dedupeKey`
 * is the CollectionStepExecution's own id, which is already unique per
 * (sequence, step) via the DB constraint above, so this BusinessEvent
 * creation can never collide across steps or sequences.
 */
async function runStepThroughOperator(
  sequence: CollectionSequence,
  step: CollectionPolicyStep,
  stepExecutionId: string,
  today: string,
) {
  const context = await buildDeterministicInvoiceContext(sequence.organizationId, sequence.invoiceId, today);

  let businessEvent;
  try {
    businessEvent = await prisma.businessEvent.create({
      data: {
        organizationId: sequence.organizationId,
        type: "COLLECTION_STEP_DUE",
        customerId: sequence.customerId,
        invoiceId: sequence.invoiceId,
        dedupeKey: stepExecutionId,
        data: {
          invoiceNumber: context.invoiceNumber,
          currency: context.currency,
          outstandingAmount: context.outstandingAmount,
          dueDate: context.dueDate,
          daysOverdue: context.daysOverdue,
          stepDaysAfterDue: step.daysAfterDue,
          stepAction: step.action,
          stepTone: step.tone,
        },
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_CONSTRAINT_VIOLATION) {
      businessEvent = await prisma.businessEvent.findUniqueOrThrow({
        where: {
          organizationId_type_dedupeKey: {
            organizationId: sequence.organizationId,
            type: "COLLECTION_STEP_DUE",
            dedupeKey: stepExecutionId,
          },
        },
      });
    } else {
      throw error;
    }
  }

  const { insight } = await ensureInsightForInvoiceOverdueEvent(sequence.organizationId, businessEvent);
  const { proposal } = await ensureReminderProposalForInsight(sequence.organizationId, insight, {
    tone: step.tone.toLowerCase(),
  });

  return { businessEvent, insight, proposal };
}

/**
 * AUTO_SEND composes only existing, already-safe primitives —
 * approveActionProposal and sendCommunication — never a direct provider
 * call (section 21: automation must never call `nodemailer.sendMail()`
 * itself). `actingUserId` is CollectionPolicy.autoSendEnabledByUserId,
 * captured at the moment an OWNER explicitly opted in
 * (src/server/collections/policy.ts), so every automatic approval/send has
 * a real, auditable acting user — never a null/system sentinel.
 */
async function executeAutoSend(
  sequence: CollectionSequence,
  proposalId: string,
  actingUserId: string,
  today: string,
  emailProvider?: EmailProvider,
  messagingProvider?: MessagingProvider,
  aiOverride?: AiOverride,
): Promise<void> {
  try {
    await approveActionProposal(sequence.organizationId, proposalId, actingUserId);
    const { communication } = await prepareReminderCommunication(sequence.organizationId, proposalId, aiOverride);

    // Defense-in-depth, immediately before the external call, since a full
    // round trip through approve+prepare has elapsed since the sequence-
    // status check earlier in processSequenceTick: re-verify the sequence
    // is still ACTIVE, org automation is still enabled, and the policy is
    // still AUTO_SEND — an OWNER could have paused this sequence, flipped
    // the organization kill switch, or switched the policy back to
    // APPROVAL_REQUIRED while drafting was in flight. None of those are
    // re-checked anywhere else between the claim and this point.
    if (!(await isAutoSendStillAuthorized(sequence))) return;

    // Fresh financial re-check for the same reason (section 12).
    const fresh = await getInvoiceWithFinancials(sequence.organizationId, sequence.invoiceId, today);
    if (fresh.financials.isPaid || fresh.invoice.status === "CANCELLED") {
      // Do not send. The proposal/communication are left as-is (APPROVED/
      // DRAFT) for a human to review; the next tick's payment/cancellation
      // check stops the sequence properly. Never call sendCommunication here.
      return;
    }

    await sendCommunication(sequence.organizationId, communication.id, actingUserId, {
      provider: emailProvider,
      messagingProvider,
      actorSource: "AUTOMATION",
    });
  } catch (error) {
    // Not retried automatically within this tick — surfaced via the
    // Communication's own FAILED/UNCERTAIN status and the existing manual
    // retry flow (section 23: no new retry infrastructure).
    logAutoSendFailure(sequence.organizationId, proposalId, error);
  }
}

/**
 * Re-verifies, from fresh reads (never the in-memory values threaded
 * through the tick), that every condition AUTO_SEND depends on still
 * holds: the sequence hasn't been paused/stopped, the organization kill
 * switch hasn't been flipped off, and the policy hasn't been disabled or
 * switched back to APPROVAL_REQUIRED — all of which an OWNER can do at
 * any moment, including in the window between this step being claimed
 * and the email actually being dispatched. Exported for direct testing —
 * see docs/collections-automation.md#concurrency.
 */
export async function isAutoSendStillAuthorized(sequence: CollectionSequence): Promise<boolean> {
  const [currentSequence, organization, policy] = await Promise.all([
    prisma.collectionSequence.findUnique({ where: { id: sequence.id }, select: { status: true } }),
    prisma.organization.findUnique({ where: { id: sequence.organizationId }, select: { automationEnabled: true } }),
    prisma.collectionPolicy.findUnique({
      where: { id: sequence.policyId },
      select: { enabled: true, automationMode: true },
    }),
  ]);
  return (
    currentSequence?.status === "ACTIVE" &&
    organization?.automationEnabled === true &&
    policy?.enabled === true &&
    policy?.automationMode === "AUTO_SEND"
  );
}

/**
 * Structured, secret-free observability (section 38) — counts and ids
 * only, never email bodies, AI provider credentials, or the scheduler
 * secret. Sufficient to answer "why didn't invoice X get its next
 * reminder?" by cross-referencing ActivityEvent/CollectionStepExecution
 * rows for that invoice's sequence, not by re-reading this log line.
 */
function logTickSummary(organizationId: string | undefined, summary: AutomationTickSummary, durationMs: number): void {
  console.info(
    `[automation] tick complete organizationId=${organizationId ?? "ALL"} durationMs=${durationMs} ${JSON.stringify(summary)}`,
  );
}

function logOrganizationFailure(organizationId: string, error: unknown): void {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[automation] failed to process organization (isolated from the rest of the batch) organizationId=${organizationId}: ${name}: ${message}`,
  );
}

function logSequenceFailure(organizationId: string, sequenceId: string, error: unknown): void {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[automation] failed to process sequence organizationId=${organizationId} sequenceId=${sequenceId}: ${name}: ${message}`,
  );
}

function logAutoSendFailure(organizationId: string, proposalId: string, error: unknown): void {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[automation] auto-send failed organizationId=${organizationId} proposalId=${proposalId}: ${name}: ${message}`,
  );
}
