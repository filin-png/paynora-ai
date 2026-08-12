/**
 * Thrown by callers that want a rate-limit rejection to surface as a
 * normal, catchable domain error (e.g. provider-abuse-control call sites
 * — see docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-7). Auth
 * deliberately does NOT use this: a rate-limited login attempt returns
 * the same generic failure as a wrong password, never a distinct error
 * message, to stay enumeration-safe.
 */
export class RateLimitExceededError extends Error {
  constructor(
    public readonly resetAt: Date,
    message = "Too many requests — please try again later.",
  ) {
    super(message);
    this.name = "RateLimitExceededError";
  }
}
