import { RateLimitExceededError } from "@/server/rate-limit/errors";
import { operatorRunPolicy } from "@/server/rate-limit/policies";
import { checkRateLimit } from "@/server/rate-limit/service";
import { detectInvoiceOverdueEvents } from "./events";
import { ensureInsightForInvoiceOverdueEvent } from "./insights";
import { ensureReminderProposalForInsight } from "./proposals";

export type OperatorRunSummary = {
  eventsDetected: number;
  eventsNew: number;
  insightsCreated: number;
  proposalsCreated: number;
  aiGeneratedInsights: number;
  failures: number;
};

/**
 * The full Operator pipeline: detect -> deterministic context -> analyze
 * (deterministic + optional AI) -> insight -> proposal. No cron or queue
 * infrastructure — this is the one function a manual "Run Operator" click
 * (or, in a later phase, a scheduler) calls; it does the whole thing
 * synchronously and returns a summary.
 *
 * Safe to call repeatedly for the same organization at any time: every
 * step it delegates to (detectInvoiceOverdueEvents,
 * ensureInsightForInvoiceOverdueEvent, ensureReminderProposalForInsight)
 * is independently idempotent via a DB unique constraint, not just an
 * in-memory check — so a run that partially failed and gets retried picks
 * up exactly where it left off instead of duplicating anything already
 * created. A failure processing one event (including an AI failure that
 * somehow escaped src/server/ai/service.ts's own handling) is caught and
 * counted, not allowed to abort the run for every other event.
 */
export async function runOperator(organizationId: string): Promise<OperatorRunSummary> {
  // Bounds how often this organization can trigger a full pipeline run
  // (each one can invoke AI for every newly-detected event) — see
  // docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-7. Unlike AI
  // generation inside a single reminder, there's no safe degraded
  // behavior for "run the pipeline anyway" — a rate-limited run is
  // refused outright, exactly like the automation tick endpoint refuses
  // an unauthorized request, and fails closed on an unexpected
  // rate-limiter error for the same reason every other check in this
  // codebase does.
  const runLimit = await checkRateLimit("operator:run", organizationId, operatorRunPolicy());
  if (!runLimit.allowed) {
    throw new RateLimitExceededError(
      runLimit.resetAt,
      "This organization has reached its hourly limit for checking for new actions. Please try again later.",
    );
  }

  const startedAt = Date.now();
  const summary: OperatorRunSummary = {
    eventsDetected: 0,
    eventsNew: 0,
    insightsCreated: 0,
    proposalsCreated: 0,
    aiGeneratedInsights: 0,
    failures: 0,
  };

  const detected = await detectInvoiceOverdueEvents(organizationId);
  summary.eventsDetected = detected.length;
  summary.eventsNew = detected.filter((entry) => entry.created).length;

  for (const { event } of detected) {
    try {
      const { insight, created: insightCreated } = await ensureInsightForInvoiceOverdueEvent(
        organizationId,
        event,
      );
      if (insightCreated) {
        summary.insightsCreated += 1;
        if (insight.aiGenerated) summary.aiGeneratedInsights += 1;
      }

      const { created: proposalCreated } = await ensureReminderProposalForInsight(organizationId, insight);
      if (proposalCreated) summary.proposalsCreated += 1;
    } catch (error) {
      summary.failures += 1;
      logOperatorEventFailure(organizationId, event.id, error);
    }
  }

  logOperatorRun(organizationId, summary, Date.now() - startedAt);
  return summary;
}

/**
 * Structured, secret-free observability logging. Never logs invoice
 * amounts, customer contact details, or AI provider credentials — only
 * ids and counts. See docs/operator-foundation.md#observability.
 */
function logOperatorRun(organizationId: string, summary: OperatorRunSummary, durationMs: number): void {
  console.info(
    `[operator] run complete organizationId=${organizationId} durationMs=${durationMs} ${JSON.stringify(summary)}`,
  );
}

function logOperatorEventFailure(organizationId: string, eventId: string, error: unknown): void {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[operator] failed to process event organizationId=${organizationId} eventId=${eventId}: ${name}: ${message}`,
  );
}
