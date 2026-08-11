/**
 * Every failure mode an AIProvider call can hit, normalized so callers
 * never need to know which vendor SDK produced the failure. Operator code
 * catches these as a group (see src/server/ai/service.ts) and always
 * degrades gracefully — an AI failure of any of these kinds must never
 * throw out of the Operator pipeline or block AR Core.
 */

/** AI is turned off (AI_PROVIDER=none, the default) or not yet configured. */
export class AIDisabledError extends Error {
  constructor() {
    super("AI is disabled (AI_PROVIDER=none)");
    this.name = "AIDisabledError";
  }
}

/** The provider call did not complete within the allotted time. */
export class AITimeoutError extends Error {
  constructor(provider: string, timeoutMs: number) {
    super(`AI provider "${provider}" timed out after ${timeoutMs}ms`);
    this.name = "AITimeoutError";
  }
}

/** The provider itself failed (network error, vendor error response, etc). */
export class AIProviderError extends Error {
  constructor(provider: string, message: string) {
    super(`AI provider "${provider}" failed: ${message}`);
    this.name = "AIProviderError";
  }
}

/**
 * The provider responded, but its output didn't satisfy the request's Zod
 * schema. Treated the same as any other untrusted external input that
 * fails validation — the response is discarded, not partially trusted.
 */
export class AIValidationError extends Error {
  constructor(provider: string, message: string) {
    super(`AI provider "${provider}" returned output that failed validation: ${message}`);
    this.name = "AIValidationError";
  }
}
