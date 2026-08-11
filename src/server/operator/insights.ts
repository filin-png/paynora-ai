import { Prisma, type BusinessEvent, type InsightPriority, type OperatorInsight } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { tryGenerateStructured } from "@/server/ai/service";
import { buildDeterministicInvoiceContext, type DeterministicInvoiceContext } from "@/server/ar/reminder-context";
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
async function generateInsightSummary(context: DeterministicInvoiceContext): Promise<GeneratedSummary> {
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
  const { summary, aiGenerated, aiProvider } = await generateInsightSummary(context);

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
