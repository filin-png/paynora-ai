import { Prisma, type ActionProposal, type Communication } from "@prisma/client";

import type { AiProviderName } from "@/server/ai/service";
import { tryGenerateStructured } from "@/server/ai/service";
import type { AIProvider } from "@/server/ai/types";
import { recordActivityEvent } from "@/server/ar/activity";
import { getCustomer } from "@/server/ar/customers";
import { buildDeterministicInvoiceContext } from "@/server/ar/reminder-context";
import { prisma } from "@/server/db/client";
import { aiGenerationPolicy } from "@/server/rate-limit/policies";
import { checkRateLimit } from "@/server/rate-limit/service";
import { buildReminderEmailRequest } from "./ai-context";
import { checkGeneratedReminderSafety } from "./ai-safety";
import { resolveCommunicationDestination } from "./channel";
import {
  CommunicationChannelBlockedError,
  CommunicationResourceNotFoundError,
  InvalidActionProposalForCommunicationError,
} from "./errors";
import { buildDeterministicReminderEmail, type ReminderEmailContext } from "./templates";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

async function getTenantActionProposal(
  organizationId: string,
  actionProposalId: string,
): Promise<ActionProposal> {
  const proposal = await prisma.actionProposal.findFirst({
    where: { id: actionProposalId, organizationId },
  });
  if (!proposal) throw new CommunicationResourceNotFoundError("Action proposal");
  return proposal;
}

/**
 * Phase 9 (docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-2/P1-3): AI
 * output is validated against the same deterministic facts it was given
 * — checkGeneratedReminderSafety — before it is ever accepted. A failed
 * check degrades to the existing deterministic template, exactly like a
 * disabled/errored/timed-out AI call already did; this is not a new
 * fallback path, it is the same one with one more condition that reaches
 * it. `aiSafetyRejectionReason` is returned (never the rejected content
 * itself) purely so the caller can record an auditable, secret-free trail
 * of *that* a rejection happened — see prepareReminderCommunication.
 */
export type AiOverride = {
  enabled?: boolean;
  order?: AiProviderName[];
  resolve?: (name: AiProviderName) => AIProvider;
};

/**
 * Phase 9 (docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-7): bounds AI
 * provider spend/abuse per organization per hour. A rate-limited (or
 * otherwise-erroring) check degrades to the deterministic template
 * exactly like a disabled/unreachable AI provider already does — never
 * blocks preparing a reminder, only whether AI is attempted for it. This
 * makes "fail closed" and "fail safe" the same behavior here: refusing to
 * spend more AI budget is itself the safe fallback, so there is nothing
 * to distinguish between an over-limit result and a checker error.
 */
async function aiGenerationAllowed(organizationId: string): Promise<boolean> {
  try {
    const result = await checkRateLimit("ai:generation", organizationId, aiGenerationPolicy());
    return result.allowed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[communications] AI generation rate limit check failed — degrading to deterministic template: ${message}`);
    return false;
  }
}

async function generateReminderEmail(
  organizationId: string,
  context: ReminderEmailContext,
  aiOverride?: AiOverride,
) {
  if (!(await aiGenerationAllowed(organizationId))) {
    return { ...buildDeterministicReminderEmail(context), aiGenerated: false as const };
  }
  const aiResult = await tryGenerateStructured(buildReminderEmailRequest(context), aiOverride);
  if (!aiResult) {
    return { ...buildDeterministicReminderEmail(context), aiGenerated: false as const };
  }
  const safety = checkGeneratedReminderSafety(aiResult.data, context);
  if (!safety.safe) {
    return {
      ...buildDeterministicReminderEmail(context),
      aiGenerated: false as const,
      aiSafetyRejectionReason: safety.reason,
    };
  }
  return { subject: aiResult.data.subject, body: aiResult.data.body, aiGenerated: true as const, aiProvider: aiResult.provider };
}

export type EnsuredCommunication = { communication: Communication; created: boolean };

/**
 * Idempotent: a second call for the same proposal finds the existing
 * Communication via the unique constraint on `actionProposalId` rather
 * than creating a duplicate or re-running AI — same pattern as
 * src/server/operator/insights.ts's ensureInsightForInvoiceOverdueEvent.
 * A fresh draft can only be created from a proposal that is APPROVED and
 * of the allowlisted SEND_PAYMENT_REMINDER type; once a Communication
 * exists for a proposal, this always returns it unchanged regardless of
 * the proposal's current status (including EXECUTED) — preparing is a
 * read-through-or-create operation, not a status check on every call.
 * See docs/communications.md.
 *
 * `aiOverride` is a test-only dependency-injection point (mirrors
 * `sendCommunication`'s `provider` option, `runAutomationTick`'s
 * `emailProvider` option — the same pattern used throughout this
 * codebase) — see draft.test.ts and engine.test.ts for how it's used to
 * exercise the AI-safety-rejection fallback deterministically, without a
 * real AI credential. Production callers never pass it.
 */
export async function prepareReminderCommunication(
  organizationId: string,
  actionProposalId: string,
  aiOverride?: AiOverride,
): Promise<EnsuredCommunication> {
  const proposal = await getTenantActionProposal(organizationId, actionProposalId);

  const existing = await prisma.communication.findUnique({
    where: { actionProposalId: proposal.id },
  });
  if (existing) return { communication: existing, created: false };

  if (proposal.type !== "SEND_PAYMENT_REMINDER") {
    throw new InvalidActionProposalForCommunicationError(
      `Cannot prepare a communication for action type "${proposal.type}"`,
    );
  }
  if (proposal.status !== "APPROVED") {
    throw new InvalidActionProposalForCommunicationError(
      `Action proposal must be APPROVED before a communication can be prepared (current status: ${proposal.status})`,
    );
  }
  if (!proposal.customerId || !proposal.invoiceId) {
    throw new InvalidActionProposalForCommunicationError(
      "Action proposal is missing a customer or invoice reference",
    );
  }

  const [customer, organization, invoiceContext] = await Promise.all([
    getCustomer(organizationId, proposal.customerId),
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
    buildDeterministicInvoiceContext(organizationId, proposal.invoiceId),
  ]);

  const destination = resolveCommunicationDestination(customer);
  if (destination.blocked) throw new CommunicationChannelBlockedError(destination.reason);

  const emailContext: ReminderEmailContext = { ...invoiceContext, organizationName: organization.name };
  const content = await generateReminderEmail(organizationId, emailContext, aiOverride);
  const channelLabel = destination.channel === "EMAIL" ? "email" : "Telegram message";

  try {
    const communication = await prisma.$transaction(async (tx) => {
      const created = await tx.communication.create({
        data: {
          organizationId,
          customerId: proposal.customerId!,
          invoiceId: proposal.invoiceId!,
          actionProposalId: proposal.id,
          channel: destination.channel,
          purpose: "PAYMENT_REMINDER",
          recipient: destination.destination,
          subject: content.subject,
          body: content.body,
          aiGenerated: content.aiGenerated,
          aiProvider: "aiProvider" in content ? content.aiProvider : undefined,
        },
      });
      await recordActivityEvent(tx, {
        organizationId,
        type: "COMMUNICATION_PREPARED",
        summary:
          "aiSafetyRejectionReason" in content
            ? `Payment reminder ${channelLabel} drafted for invoice ${proposal.invoiceId} (AI draft rejected by safety check, deterministic template used instead)`
            : `Payment reminder ${channelLabel} drafted for invoice ${proposal.invoiceId}`,
        customerId: proposal.customerId ?? undefined,
        invoiceId: proposal.invoiceId ?? undefined,
        // Never the rejected AI content itself — only the deterministic
        // category name (e.g. "body mentions an amount other than the
        // actual outstanding amount") — see
        // docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-2.
        metadata:
          "aiSafetyRejectionReason" in content
            ? { aiSafetyRejectionReason: content.aiSafetyRejectionReason }
            : undefined,
      });
      return created;
    });
    return { communication, created: true };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_CONSTRAINT_VIOLATION
    ) {
      const raced = await prisma.communication.findUniqueOrThrow({
        where: { actionProposalId: proposal.id },
      });
      return { communication: raced, created: false };
    }
    throw error;
  }
}

export async function getCommunicationForProposal(
  organizationId: string,
  actionProposalId: string,
): Promise<Communication | null> {
  return prisma.communication.findFirst({ where: { organizationId, actionProposalId } });
}

export async function getCommunication(
  organizationId: string,
  communicationId: string,
): Promise<Communication> {
  const communication = await prisma.communication.findFirst({
    where: { id: communicationId, organizationId },
  });
  if (!communication) throw new CommunicationResourceNotFoundError("Communication");
  return communication;
}
