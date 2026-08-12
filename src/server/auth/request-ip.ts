/**
 * Best-effort client IP extraction from forwarded headers — there is no
 * fully trustworthy way to get a client IP behind a reverse proxy without
 * that proxy's cooperation, so this is a defense-in-depth signal for rate
 * limiting, not an identity/authorization fact. A production deployment
 * MUST run behind a proxy/load balancer that sets `X-Forwarded-For` (or
 * `X-Real-IP`) correctly and strips/overwrites any client-supplied value
 * of the same header — see DEPLOYMENT.md#connection-pooling. If neither
 * header is present, every caller collapses into one "unknown" bucket for
 * the IP-scoped rate limit, which degrades that dimension to a shared
 * budget but does not remove the independent, IP-agnostic per-account
 * limit — see docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P0-1.
 */
export function extractClientIp(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}
