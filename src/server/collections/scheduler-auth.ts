import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time secret comparison so a mistimed response can't leak the
 * cron secret one byte at a time. `timingSafeEqual` throws on mismatched
 * buffer lengths, so a length check up front (itself not timing-sensitive
 * — string length isn't secret) short-circuits safely.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Authenticates the internal scheduler endpoint (POST
 * /internal/automation/tick) — a Bearer token in the Authorization header,
 * never a query param or request body (so it can never end up in access
 * logs or a browser history). Returns false whenever the deployment hasn't
 * configured a secret at all: an unconfigured deployment must reject every
 * request, not silently accept anything, since a missing expected value is
 * not the same as "authentication disabled" anywhere else in this app —
 * see docs/collections-automation.md#scheduler-deployment.
 */
export function verifyCronSecret(authorizationHeader: string | null, expectedSecret: string | undefined): boolean {
  if (!expectedSecret) return false;
  if (!authorizationHeader) return false;
  const match = /^Bearer (.+)$/.exec(authorizationHeader);
  if (!match) return false;
  return safeEqual(match[1]!, expectedSecret);
}
