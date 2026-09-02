import { Prisma, type BusinessEvent, type InsightPriority, type OperatorInsight } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { tryGenerateStructured } from "@/server/ai/service";
import { formatMoney } from "@/server/ar/money";
import { buildDeterministicInvoiceContext, type DeterministicInvoiceContext } from "@/server/ar/reminder-context";
import { checkAiGenerationQuota } from "@/server/billing/entitlements";
import { buildReminderInsightRequest } from "./ai-context";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

const HIGH_PRIORITY_DAYS_OVERDUE = 30;
const MEDIUM_PRIORITY_DAYS_OVERDUE = 7;

/**
 * The one and only place priority is decided — a pure function of how
 * overdue the invoice is, always computed, never asked of or overridable
 * by AI. See docs/operator-foundation.md#priority.
 */
export function computeOverduePriority(daysOverdue: number): InsightPriority {
  if (daysOverdue >= HIGH_PRIORITY_DAYS_OVERDUE) return "HIGH";
  if (daysOverdue >= MEDIUM_PRIORITY_DAYS_OVERDUE) return "MEDIUM";
  return "LOW";
}

function buildDeterministicSummary(context: DeterministicInvoiceContext): string {
  return `Invoice ${context.invoiceNumber} for ${context.customerName} is ${context.daysOverdue} day(s) overdue — ${context.outstandingAmount} outstanding (was due ${context.dueDate}).`;
}

type GeneratedSummary = { summary: string; aiGenerated: boolean; aiProvider?: string };

/**
 * Always has a deterministic answer (`buildDeterministicSummary`); AI, if
 * enabled and successful, is only ever allowed to replace the *wording* of
 * that answer, validated against reminderInsightOutputSchema before it's
 * trusted at all. Never affects priority or any financial field — those
 * are computed before this is even called and passed in unchanged.
 */
/**
 * Checked before every AI attempt, alongside the deterministic fallback
 * every AI call in this codebase already has — a denied plan quota
 * degrades to `buildDeterministicSummary` exactly like a disabled/failed
 * provider already does, and never reaches `tryGenerateStructured` (so a
 * denied quota can never trigger a real provider call). See
 * src/server/billing/entitlements.ts#checkAiGenerationQuota for why this
 * is a distinct check from any abuse-protection rate limit.
 */
async function generateInsightSummary(
  organizationId: string,
  context: DeterministicInvoiceContext,
): Promise<GeneratedSummary> {
  if (!(await checkAiGenerationQuota(organizationId))) {
    return { summary: buildDeterministicSummary(context), aiGenerated: false };
  }
  const aiResult = await tryGenerateStructured(buildReminderInsightRequest(context));
  if (!aiResult) {
    return { summary: buildDeterministicSummary(context), aiGenerated: false };
  }
  return { summary: aiResult.data.summary, aiGenerated: true, aiProvider: aiResult.provider };
}

export type EnsuredInsight = { insight: OperatorInsight; created: boolean };

/**
 * Idempotent: a second call for the same BusinessEvent finds the existing
 * row via the unique constraint on [organizationId, businessEventId]
 * rather than creating a duplicate or re-running AI. Tenant-scoped through
 * `organizationId`, which is threaded into both the lookup
 * (buildInvoiceOverdueContext re-verifies the invoice belongs to this org)
 * and the row itself.
 *
 * Despite the name, nothing here actually depends on `event.type` being
 * INVOICE_OVERDUE — only on `event.invoiceId` being set. Phase 5's
 * collections automation engine (src/server/collections/engine.ts) reuses
 * this exact function for its own COLLECTION_STEP_DUE events rather than
 * building a second insight generator — see docs/collections-automation.md
 * #operator-integration for why that's safe (priority/summary are still
 * computed the same deterministic way either event type).
 */
export async function ensureInsightForInvoiceOverdueEvent(
  organizationId: string,
  event: BusinessEvent,
): Promise<EnsuredInsight> {
  if (!event.invoiceId) {
    throw new Error("INVOICE_OVERDUE event is missing an invoiceId");
  }
  const context = await buildDeterministicInvoiceContext(organizationId, event.invoiceId);
  const priority = computeOverduePriority(context.daysOverdue);
  const { summary, aiGenerated, aiProvider } = await generateInsightSummary(organizationId, context);

  try {
    const insight = await prisma.operatorInsight.create({
      data: {
        organizationId,
        businessEventId: event.id,
        customerId: event.customerId,
        invoiceId: event.invoiceId,
        priority,
        summary,
        aiGenerated,
        aiProvider,
      },
    });
    return { insight, created: true };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_CONSTRAINT_VIOLATION
    ) {
      const existing = await prisma.operatorInsight.findUniqueOrThrow({
        where: { organizationId_businessEventId: { organizationId, businessEventId: event.id } },
      });
      return { insight: existing, created: false };
    }
    throw error;
  }
}

/**
 * Shared create-or-find-existing helper for the two Phase 16 insight
 * functions below — same idempotency guarantee as
 * `ensureInsightForInvoiceOverdueEvent` above (the DB unique constraint on
 * `[organizationId, businessEventId]`), factored out so they don't repeat
 * the same try/catch. Deliberately never calls AI — both event types are
 * informational (not a reminder to send), so a fixed deterministic summary
 * is already the whole answer; see the two callers for why.
 */
async function ensureDeterministicInsight(
  organizationId: string,
  event: BusinessEvent,
  priority: InsightPriority,
  summary: string,
): Promise<EnsuredInsight> {
  try {
    const insight = await prisma.operatorInsight.create({
      data: {
        organizationId,
        businessEventId: event.id,
        customerId: event.customerId,
        invoiceId: event.invoiceId,
        priority,
        summary,
        aiGenerated: false,
      },
    });
    return { insight, created: true };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_CONSTRAINT_VIOLATION
    ) {
      const existing = await prisma.operatorInsight.findUniqueOrThrow({
        where: { organizationId_businessEventId: { organizationId, businessEventId: event.id } },
      });
      return { insight: existing, created: false };
    }
    throw error;
  }
}

type PaymentReceivedEventData = {
  invoiceNumber: string;
  currency: string;
  amountMinor: string;
  paidAt: string;
};

/**
 * Phase 16 — always LOW priority: this is good news, not something that
 * needs approval or action. Reads the event's own `data` snapshot rather
 * than re-querying, which is safe here specifically because a recorded
 * Payment's amount/date are immutable historical facts once created —
 * unlike an invoice's "is it overdue," which can change every day and
 * must always be recomputed live.
 */
export async function ensureInsightForPaymentReceivedEvent(
  organizationId: string,
  event: BusinessEvent,
): Promise<EnsuredInsight> {
  const data = event.data as unknown as PaymentReceivedEventData;
  const amountMinor = BigInt(data.amountMinor);
  const amount = formatMoney(amountMinor, data.currency as Parameters<typeof formatMoney>[1]);
  const summary = `Payment of ${amount} received for invoice ${data.invoiceNumber}.`;
  return ensureDeterministicInsight(organizationId, event, "LOW", summary);
}

type CustomerBehaviorDeterioratedEventData = {
  recentAvgDelayDays: number;
  previousAvgDelayDays: number;
  deltaDays: number;
  detectedOn: string;
};

/**
 * Phase 16 — always MEDIUM priority: worth a look, but (unlike an overdue
 * invoice) not itself a specific dollar amount at risk yet. `event.data`
 * is the trend snapshot at detection time; see
 * src/server/customer-intelligence/trends.ts for how it was computed.
 */
export async function ensureInsightForCustomerBehaviorEvent(
  organizationId: string,
  event: BusinessEvent,
): Promise<EnsuredInsight> {
  const data = event.data as unknown as CustomerBehaviorDeterioratedEventData;
  const summary = `Payment behavior deteriorated: recent average delay is ${data.recentAvgDelayDays} day(s), up from ${data.previousAvgDelayDays} day(s) previously.`;
  return ensureDeterministicInsight(organizationId, event, "MEDIUM", summary);
}
