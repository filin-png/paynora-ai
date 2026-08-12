import { env } from "@/lib/env";
import type { RateLimitPolicy } from "./types";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * A single source of truth for every named rate-limit policy in the app —
 * see docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P0-1/P1-7 for the
 * reasoning behind each threshold.
 *
 * Auth thresholds are fixed constants, not env-configurable: they're a
 * correctness/safety property (like bcrypt's SALT_ROUNDS in password.ts),
 * not a business knob. Provider-abuse thresholds ARE env-configurable
 * (`RATE_LIMIT_*`) since "how much AI/send volume is normal" genuinely
 * varies by deployment and is explicitly not this codebase's business to
 * hardcode as a commercial tier.
 */
export const AUTH_IP_POLICY: RateLimitPolicy = {
  // Broad protection against one source hammering many accounts
  // (credential stuffing) — generous enough that a shared office/NAT IP
  // with several people signing in around the same time won't trip it.
  maxAttempts: 30,
  windowMs: FIFTEEN_MINUTES_MS,
};

export const AUTH_ACCOUNT_POLICY: RateLimitPolicy = {
  // Protects one specific account from being brute-forced regardless of
  // source IP. Only failed attempts persist against this — a successful
  // login resets it (see src/server/rate-limit/service.ts#resetRateLimit),
  // so a normal user who mistypes their password a few times and then
  // gets in is never inconvenienced by that history. Time-bound (resets
  // automatically after the window), so this can never become a
  // permanent account lockout an attacker could weaponize against a real
  // user by deliberately failing their login.
  maxAttempts: 10,
  windowMs: FIFTEEN_MINUTES_MS,
};

export const SIGNUP_IP_POLICY: RateLimitPolicy = {
  // Bounds automated mass account creation / email-enumeration-by-signup
  // from one source — see docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P2-1.
  maxAttempts: 10,
  windowMs: ONE_HOUR_MS,
};

export function aiGenerationPolicy(): RateLimitPolicy {
  return { maxAttempts: env.RATE_LIMIT_AI_GENERATION_PER_HOUR, windowMs: ONE_HOUR_MS };
}

export function communicationSendPolicy(): RateLimitPolicy {
  return { maxAttempts: env.RATE_LIMIT_COMMUNICATION_SEND_PER_HOUR, windowMs: ONE_HOUR_MS };
}

export function operatorRunPolicy(): RateLimitPolicy {
  return { maxAttempts: env.RATE_LIMIT_OPERATOR_RUN_PER_HOUR, windowMs: ONE_HOUR_MS };
}
