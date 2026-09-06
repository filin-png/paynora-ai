import { tryGenerateStructured } from "@/server/ai/service";
import { getAttentionScoresForInvoiceIds } from "@/server/attention/for-invoices";
import { getPaymentOutlookForInvoiceIds } from "@/server/attention/payment-outlook";
import { formatMoney } from "@/server/ar/money";
import { getCustomer } from "@/server/ar/customers";
import { getBusinessToday } from "@/server/ar/dates";
import { ArResourceNotFoundError } from "@/server/ar/errors";
import { getInvoiceWithFinancials } from "@/server/ar/invoices";
import { getCustomerReceivablesSummaries } from "@/server/ar/summary";
import { assertCopilotEntitled, checkAiGenerationQuota, recordCopilotUsage } from "@/server/billing/entitlements";
import { getDailyBrief } from "@/server/briefing/daily-brief";
import { getCashFlowRiskWindows } from "@/server/briefing/cash-flow-risk";
import { getWhatChanged } from "@/server/briefing/what-changed";
import { getCustomerPaymentTrend } from "@/server/customer-intelligence/trends";
import { getActionProposal, listPendingActionProposals } from "@/server/operator/approval";
import { OperatorResourceNotFoundError } from "@/server/operator/errors";
import { aiGenerationPolicy } from "@/server/rate-limit/policies";
import { checkRateLimit } from "@/server/rate-limit/service";
import { buildCopilotExplanationRequest } from "./ai-context";

/**
 * Phase 16 Proactive Copilot — a small, fixed set of pre-defined
 * questions, never a free-text chat box. This is a deliberate scope and
 * safety choice: every question already has a known, deterministic
 * grounding query, so there is no user-authored prompt surface for
 * injection to exploit, and no risk of the product answering a question
 * PAYNORA has no real data to support. See
 * docs/proactive-financial-operations.md#proactive-copilot.
 */
export const COPILOT_QUESTION_TYPES = [
  "why_important",
  "explain_customer",
  "explain_invoice",
  "what_changed_this_week",
  "focus_invoices",
  "cash_flow_risk",
] as const;
export type CopilotQuestionType = (typeof COPILOT_QUESTION_TYPES)[number];

export type CopilotAnswer = {
  /** Always present — see #15 in the phase brief: AI unavailable must never mean an empty answer. */
  deterministicAnswer: string;
  /** Present only when AI actually elaborated on the deterministic answer above. */
  aiAnswer?: string;
  aiGenerated: boolean;
};

async function aiAllowed(organizationId: string): Promise<boolean> {
  try {
    const result = await checkRateLimit("ai:generation", organizationId, aiGenerationPolicy());
    return result.allowed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[copilot] rate limit check failed — degrading to deterministic answer: ${message}`);
    return false;
  }
}

/**
 * The one place a deterministic answer is optionally reworded by AI.
 * Never invoked with anything but an already-final deterministic answer —
 * AI here can only rephrase, never add a fact. See ai-context.ts's system
 * prompt for the actual enforcement of that boundary.
 */
async function elaborate(
  organizationId: string,
  question: CopilotQuestionType,
  deterministicAnswer: string,
): Promise<CopilotAnswer> {
  if (!(await aiAllowed(organizationId)) || !(await checkAiGenerationQuota(organizationId))) {
    return { deterministicAnswer, aiGenerated: false };
  }
  const aiResult = await tryGenerateStructured(buildCopilotExplanationRequest(question, deterministicAnswer));
  if (!aiResult) {
    return { deterministicAnswer, aiGenerated: false };
  }
  return { deterministicAnswer, aiAnswer: aiResult.data.explanation, aiGenerated: true };
}

async function buildWhyImportantAnswer(organizationId: string, proposalId: string): Promise<string> {
  const proposal = await getActionProposal(organizationId, proposalId);
  const priorityLabel = proposal.insight.priority.charAt(0) + proposal.insight.priority.slice(1).toLowerCase();
  return `${proposal.reasoning} This is ${priorityLabel} priority.`;
}

async function buildExplainCustomerAnswer(organizationId: string, customerId: string): Promise<string> {
  const [customer, trend, receivables] = await Promise.all([
    getCustomer(organizationId, customerId),
    getCustomerPaymentTrend(organizationId, customerId),
    getCustomerReceivablesSummaries(organizationId),
  ]);

  const summary = receivables.get(customerId);
  const outstandingText =
    summary && summary.outstandingByCurrency.length > 0
      ? summary.outstandingByCurrency
          .map((o) => formatMoney(o.outstandingMinor, o.currency))
          .join(", ")
      : "nothing currently outstanding";

  const trendText =
    trend.status === "insufficient-history"
      ? "Not enough payment history yet to identify a trend."
      : trend.status === "deteriorating"
        ? `Payment behavior has deteriorated: recent average delay is ${trend.recentAvgDelayDays} day(s), up from ${trend.previousAvgDelayDays} day(s).`
        : trend.status === "improving"
          ? `Payment behavior has improved: recent average delay is ${trend.recentAvgDelayDays} day(s), down from ${trend.previousAvgDelayDays} day(s).`
          : `Payment behavior is stable: recent average delay is ${trend.recentAvgDelayDays} day(s).`;

  return `${customer.name} — outstanding: ${outstandingText}. ${trendText}`;
}

/**
 * Phase 22 — answers "why did this invoice get [high/this] risk" for any
 * invoice, not just ones with a pending proposal (unlike `why_important`,
 * which needs an ActionProposal). Reuses the exact same
 * `getAttentionScoresForInvoiceIds`/`getPaymentOutlookForInvoiceIds` bulk
 * helpers the invoice list and Action Center already call — never a
 * second scoring implementation, just a single-invoice lookup through the
 * bulk API.
 */
async function buildExplainInvoiceAnswer(organizationId: string, invoiceId: string): Promise<string> {
  const { invoice, financials } = await getInvoiceWithFinancials(organizationId, invoiceId);
  if (financials.isPaid) {
    return `${invoice.number} is fully paid — no outstanding risk.`;
  }

  const [pendingProposals, outlooks] = await Promise.all([
    listPendingActionProposals(organizationId),
    getPaymentOutlookForInvoiceIds(organizationId, [invoiceId], getBusinessToday()),
  ]);
  const hasUnresolvedAction = pendingProposals.some((p) => p.invoiceId === invoiceId);
  const attention = (
    await getAttentionScoresForInvoiceIds(organizationId, [invoiceId], new Set(hasUnresolvedAction ? [invoiceId] : []))
  ).get(invoiceId)!;
  const outlook = outlooks.get(invoiceId);

  const factorText = attention.attention.factors
    .filter((f) => f.value > 0)
    .map((f) => f.label.toLowerCase())
    .join(", ");
  const outlookText = outlook ? ` ${outlook.explanation}` : "";
  return `${invoice.number} has an attention score of ${attention.attention.score}/100, driven mainly by: ${factorText || "no significant factors"}.${outlookText}`;
}

async function buildWhatChangedAnswer(organizationId: string): Promise<string> {
  const changes = await getWhatChanged(organizationId, 24 * 7);
  if (changes.length === 0) return "Nothing notable changed in the last 7 days.";
  return changes.map((c) => c.description).join("; ") + ".";
}

async function buildFocusInvoicesAnswer(organizationId: string): Promise<string> {
  const brief = await getDailyBrief(organizationId);
  if (brief.attentionItems.length === 0) return "No invoices need attention right now.";
  const items = brief.attentionItems
    .map(
      (item) =>
        `${item.invoiceNumber} (${item.customerName}, ${formatMoney(item.outstandingMinor, item.currency)}, ${item.daysOverdue}d overdue, attention score ${item.attention.score})`,
    )
    .join("; ");
  return `Focus on these invoices first: ${items}.`;
}

async function buildCashFlowRiskAnswer(organizationId: string): Promise<string> {
  const brief = await getDailyBrief(organizationId);
  if (!brief.primaryCurrency || brief.cashFlowRiskWindows.length === 0) {
    return "There isn't enough open-invoice data yet to estimate cash-flow risk windows.";
  }
  const windows = await getCashFlowRiskWindows(organizationId, brief.primaryCurrency);
  const risky = windows.filter((w) => w.isPotentialRisk);
  if (risky.length === 0) {
    return "No cash-flow risk windows identified in the near term based on current data.";
  }
  const text = risky
    .map(
      (w) =>
        `${w.weekStart} to ${w.weekEnd}: ${formatMoney(w.expectedInMinor, brief.primaryCurrency!)} expected, an estimated ${formatMoney(w.estimatedAtRiskMinor, brief.primaryCurrency!)} potentially at risk based on this organization's historical overdue rate`,
    )
    .join("; ");
  return `Potential cash-flow pressure: ${text}.`;
}

/**
 * The one entry point the UI calls. `targetId` is required for
 * `why_important` (an ActionProposal id), `explain_customer` (a Customer
 * id), and `explain_invoice` (an Invoice id, Phase 22); every other
 * question type is organization-scoped only. Tenant isolation is enforced
 * by each underlying call (getActionProposal/getCustomer/
 * getInvoiceWithFinancials already scope by organizationId and throw
 * OperatorResourceNotFoundError/ArResourceNotFoundError for a cross-tenant
 * id, the same enumeration-safe pattern as every other lookup in this
 * codebase) — this function adds no separate check because it has
 * nothing to check beyond what those calls already do.
 *
 * Phase 19: `assertCopilotEntitled` is the first thing this function does
 * — a plan without Copilot access never reaches even the deterministic
 * answer builders, throwing `FeatureNotEntitledError`
 * (src/server/billing/entitlements.ts) instead. Usage is metered via
 * `recordCopilotUsage` on every call that gets past the entitlement
 * check, regardless of whether AI elaboration itself later succeeds —
 * see that function's doc comment for why this never denies on its own.
 */
export async function answerCopilotQuestion(
  organizationId: string,
  question: CopilotQuestionType,
  targetId?: string,
): Promise<CopilotAnswer> {
  await assertCopilotEntitled(organizationId);
  await recordCopilotUsage(organizationId);

  let deterministicAnswer: string;
  switch (question) {
    case "why_important":
      if (!targetId) throw new OperatorResourceNotFoundError("Action proposal");
      deterministicAnswer = await buildWhyImportantAnswer(organizationId, targetId);
      break;
    case "explain_customer":
      if (!targetId) throw new ArResourceNotFoundError("Customer");
      deterministicAnswer = await buildExplainCustomerAnswer(organizationId, targetId);
      break;
    case "explain_invoice":
      if (!targetId) throw new ArResourceNotFoundError("Invoice");
      deterministicAnswer = await buildExplainInvoiceAnswer(organizationId, targetId);
      break;
    case "what_changed_this_week":
      deterministicAnswer = await buildWhatChangedAnswer(organizationId);
      break;
    case "focus_invoices":
      deterministicAnswer = await buildFocusInvoicesAnswer(organizationId);
      break;
    case "cash_flow_risk":
      deterministicAnswer = await buildCashFlowRiskAnswer(organizationId);
      break;
  }

  return elaborate(organizationId, question, deterministicAnswer);
}
