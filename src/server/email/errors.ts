/**
 * Every failure mode an EmailProvider call can hit, normalized so callers
 * never need to know which transport produced the failure. The
 * communications domain (src/server/communications/send.ts) is the only
 * caller and maps these onto DeliveryAttempt/Communication status —
 * critically, only EmailProviderRejectedError is ever treated as a
 * confirmed failure; everything else is treated as an unknown outcome.
 * See docs/communications.md#unknown-outcomes.
 */

/** Email sending is turned off (EMAIL_PROVIDER=none, the default) or has no configured provider. */
export class EmailDisabledError extends Error {
  constructor() {
    super("Email sending is disabled (EMAIL_PROVIDER=none)");
    this.name = "EmailDisabledError";
  }
}

/** A provider is selected but required configuration (sender address, SMTP credentials, ...) is missing. */
export class EmailConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailConfigurationError";
  }
}

/** The provider call did not complete within the allotted time — outcome unknown, not a confirmed failure. */
export class EmailTimeoutError extends Error {
  constructor(provider: string, timeoutMs: number) {
    super(`Email provider "${provider}" timed out after ${timeoutMs}ms`);
    this.name = "EmailTimeoutError";
  }
}

/**
 * The provider gave a definite, unambiguous rejection (e.g. invalid
 * recipient, authentication failure with a clear response). The only
 * error a provider adapter should throw when it is certain the message
 * was not accepted — see src/server/email/types.ts.
 */
export class EmailProviderRejectedError extends Error {
  constructor(provider: string, message: string) {
    super(`Email provider "${provider}" rejected the message: ${message}`);
    this.name = "EmailProviderRejectedError";
  }
}

/**
 * The provider call failed in a way that isn't a confirmed rejection —
 * network error, an unrecognized exception from the transport, or
 * anything else that doesn't tell us whether the message was actually
 * accepted before the failure. Deliberately the default classification:
 * see docs/communications.md#unknown-outcomes for why "we don't know"
 * is treated as its own state instead of being folded into "failed".
 */
export class EmailProviderUnknownError extends Error {
  constructor(provider: string, message: string) {
    super(`Email provider "${provider}" outcome is unknown: ${message}`);
    this.name = "EmailProviderUnknownError";
  }
}
