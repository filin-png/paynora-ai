/**
 * A fixed-window rate-limit policy: at most `maxAttempts` within any
 * single `windowMs`-long window. Deliberately the simplest correct
 * windowing model (not a sliding log) — see service.ts's doc comment for
 * why that's the right trade-off here.
 */
export type RateLimitPolicy = {
  maxAttempts: number;
  windowMs: number;
};

export type RateLimitResult = {
  allowed: boolean;
  /** Attempts remaining in the current window if `allowed`, 0 if not. */
  remaining: number;
  /** When the current window ends and the count resets to zero. */
  resetAt: Date;
};
