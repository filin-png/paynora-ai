import { prisma } from "@/server/db/client";
import type { RateLimitPolicy, RateLimitResult } from "./types";

/**
 * Fixed-window counting, not a sliding log: the window a request lands in
 * is `Math.floor(now / windowMs) * windowMs`, and every request in that
 * window shares one row. This is the standard, simple trade-off (allows
 * up to 2x `maxAttempts` in a worst-case boundary-straddling burst) in
 * exchange for one row per window instead of one row per request — more
 * than precise enough for an abuse/brute-force backstop, not a billing
 * meter. See docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P0-1.
 */
function currentWindowStart(windowMs: number, now: Date): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/**
 * Opportunistic, cheap cleanup of expired counters — no cron, no new
 * infrastructure. A 1-in-200 chance per call keeps this table from
 * growing unboundedly without adding a scheduled job; missing a cleanup
 * pass has no correctness impact (an old row is simply never read again
 * once its window has passed), only a storage-size one.
 */
async function opportunisticCleanup(now: Date): Promise<void> {
  if (Math.random() >= 1 / 200) return;
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  await prisma.rateLimitCounter.deleteMany({ where: { windowStart: { lt: cutoff } } }).catch(() => {
    // Best-effort only — never let cleanup failure affect the caller's
    // actual rate-limit check.
  });
}

/**
 * Checks and atomically consumes one attempt against `scope`+`key`'s
 * current window. Postgres-backed (RateLimitCounter, see schema.prisma)
 * rather than in-process memory — an in-memory counter is meaningless the
 * moment more than one server process exists (a second serverless
 * instance, or a second long-lived Node process behind a load balancer),
 * and PAYNORA already depends on Postgres as its one source of truth for
 * everything else. Atomicity comes from Prisma's `upsert`, which Postgres
 * compiles to `INSERT ... ON CONFLICT (scope,key,windowStart) DO UPDATE
 * ... RETURNING` — a single atomic statement, so N concurrent callers
 * hitting the same window serialize correctly and cannot trivially race
 * past `maxAttempts` (proven in service.test.ts with real concurrent
 * calls, not a single-threaded assertion).
 *
 * Fail-closed on unexpected error: if the counter table itself can't be
 * read/written for some reason unrelated to the database being down
 * outright (in which case the caller's own primary query — e.g. the user
 * lookup in auth's `authorize()` — already fails first, so there's no
 * meaningful "rate limiter down, auth up" scenario to design around
 * separately), this throws rather than silently allowing the request
 * through. See docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P0-1 for why
 * fail-closed is the documented choice here, not fail-open.
 */
export async function checkRateLimit(
  scope: string,
  key: string,
  policy: RateLimitPolicy,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const windowStart = currentWindowStart(policy.windowMs, now);
  const resetAt = new Date(windowStart.getTime() + policy.windowMs);

  await opportunisticCleanup(now);

  const counter = await prisma.rateLimitCounter.upsert({
    where: { scope_key_windowStart: { scope, key, windowStart } },
    create: { scope, key, windowStart, count: 1 },
    update: { count: { increment: 1 } },
  });

  const allowed = counter.count <= policy.maxAttempts;
  return {
    allowed,
    remaining: Math.max(0, policy.maxAttempts - counter.count),
    resetAt,
  };
}

/**
 * Clears the current window's count for `scope`+`key` — used after a
 * successful authentication so a legitimate user who mistyped their
 * password a few times isn't inconvenienced by that history once they do
 * get in. Deliberately narrow: only ever called on a *confirmed success*,
 * never speculatively, and never for the IP-scoped counter (a busy IP is
 * still worth watching even if one of the accounts it tried happened to
 * succeed).
 */
export async function resetRateLimit(
  scope: string,
  key: string,
  policy: Pick<RateLimitPolicy, "windowMs">,
  now: Date = new Date(),
): Promise<void> {
  const windowStart = currentWindowStart(policy.windowMs, now);
  await prisma.rateLimitCounter
    .update({ where: { scope_key_windowStart: { scope, key, windowStart } }, data: { count: 0 } })
    .catch(() => {
      // No existing row for this window — nothing to reset.
    });
}
