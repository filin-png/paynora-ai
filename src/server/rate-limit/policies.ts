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

// Phase 11.2: password reset requests. Same "fixed constant, not
// env-configurable" reasoning as the AUTH_* policies above. The
// account-scoped policy is deliberately stricter than sign-in's: a reset
// request also triggers a real (or would-be) outbound email, so it bounds
// email-bombing one inbox, not just brute-force guessing.
export const PASSWORD_RESET_REQUEST_IP_POLICY: RateLimitPolicy = {
  maxAttempts: 10,
  windowMs: FIFTEEN_MINUTES_MS,
};

export const PASSWORD_RESET_REQUEST_ACCOUNT_POLICY: RateLimitPolicy = {
  maxAttempts: 5,
  windowMs: FIFTEEN_MINUTES_MS,
};

// Phase 11.2: organization member invitations, scoped per organization
// (not per inviting OWNER) — bounds how many invitation emails one
// organization can generate per hour regardless of who sends them.
export const ORGANIZATION_INVITE_POLICY: RateLimitPolicy = {
  maxAttempts: 20,
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

// Phase 14: web search calls are billed per-search ($10/1,000 on the
// Anthropic adapter) — see docs/production-integrations.md#cost-control.
// Deliberately stricter than aiGenerationPolicy's default: a search is a
// distinct, additional cost on top of the tokens it also consumes.
export function webSearchPolicy(): RateLimitPolicy {
  return { maxAttempts: env.RATE_LIMIT_WEB_SEARCH_PER_HOUR, windowMs: ONE_HOUR_MS };
}
