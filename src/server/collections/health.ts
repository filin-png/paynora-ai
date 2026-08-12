import { env } from "@/lib/env";
import { prisma } from "@/server/db/client";

/**
 * How stale the most recent tick can be before automation is reported
 * "not ready" — generously larger than any realistic scheduler interval
 * (DEPLOYMENT.md documents "any interval" a scheduler is configured for),
 * so this only fires on a genuinely stopped scheduler, not a slightly
 * slow one. See docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-4.
 */
const STALE_TICK_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3 hours

const RECENT_TICKS_LIMIT = 10;

export type AutomationHealth = {
  /** Always true if this function returned at all — the process is up and can query its own state. */
  live: true;
  /**
   * False when automation is enabled but the scheduler appears to have
   * stopped (no tick within STALE_TICK_THRESHOLD_MS) or the most recent
   * tick crashed. True when automation is disabled — there is nothing to
   * be "not ready" for.
   */
  ready: boolean;
  automationEnabled: boolean;
  lastTickAt: string | null;
  lastTickCrashed: boolean | null;
  lastSuccessfulTickAt: string | null;
  recentTicks: Array<{
    startedAt: string;
    durationMs: number | null;
    crashed: boolean;
    organizationsProcessed: number;
    organizationsRemaining: number;
    executed: number;
    failed: number;
  }>;
};

/**
 * Reads the durable `AutomationTickRun` heartbeat — never a live probe,
 * never triggers a tick itself (a health check must never have a side
 * effect — same principle as src/server/providers/registry.ts's
 * configuration-derived health, see SECURITY.md). Contains no customer
 * data, message content, or provider secrets — only counts and
 * timestamps, safe to expose through an operational status surface.
 *
 * `automationEnabled` defaults to the deployment-level env flag but is
 * overridable in tests — the same dependency-injection escape hatch
 * `runAutomationTick`'s own `options.globalEnabled` is, applied to the
 * same load-time singleton (src/lib/env.ts).
 */
export async function getAutomationHealth(
  now: Date = new Date(),
  automationEnabled: boolean = env.AUTOMATION_ENABLED,
): Promise<AutomationHealth> {
  const recentRuns = await prisma.automationTickRun.findMany({
    orderBy: { startedAt: "desc" },
    take: RECENT_TICKS_LIMIT,
  });

  const lastRun = recentRuns[0] ?? null;
  const lastSuccessfulRun = recentRuns.find((run) => !run.crashed && !run.globallyDisabled) ?? null;

  const isStale = !lastRun || now.getTime() - lastRun.startedAt.getTime() > STALE_TICK_THRESHOLD_MS;
  const ready = !automationEnabled || (!isStale && lastRun !== null && !lastRun.crashed);

  return {
    live: true,
    ready,
    automationEnabled,
    lastTickAt: lastRun?.startedAt.toISOString() ?? null,
    lastTickCrashed: lastRun?.crashed ?? null,
    lastSuccessfulTickAt: lastSuccessfulRun?.startedAt.toISOString() ?? null,
    recentTicks: recentRuns.map((run) => ({
      startedAt: run.startedAt.toISOString(),
      durationMs: run.durationMs,
      crashed: run.crashed,
      organizationsProcessed: run.organizationsProcessed,
      organizationsRemaining: run.organizationsRemaining,
      executed: run.executed,
      failed: run.failed,
    })),
  };
}
