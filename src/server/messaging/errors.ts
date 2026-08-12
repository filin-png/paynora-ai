/**
 * Every failure mode a MessagingProvider call can hit, normalized so
 * callers never need to know which vendor produced the failure — mirrors
 * src/server/email/errors.ts's five-class shape exactly. Only
 * MessagingProviderRejectedError is ever a confirmed failure; everything
 * else is an unknown outcome. See docs/integration-architecture.md
 * #messaging.
 */

/** Messaging is turned off (MESSAGING_PROVIDER=none, the default) or has no configured provider. */
export class MessagingDisabledError extends Error {
  constructor() {
    super("Messaging is disabled (MESSAGING_PROVIDER=none)");
    this.name = "MessagingDisabledError";
  }
}

/** A provider is selected but required configuration (bot token, ...) is missing. */
export class MessagingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessagingConfigurationError";
  }
}

/** The provider call did not complete within the allotted time — outcome unknown, not a confirmed failure. */
export class MessagingTimeoutError extends Error {
  constructor(provider: string, timeoutMs: number) {
    super(`Messaging provider "${provider}" timed out after ${timeoutMs}ms`);
    this.name = "MessagingTimeoutError";
  }
}

/**
 * The provider gave a definite, unambiguous rejection (e.g. Telegram's
 * "chat not found" or "bot was blocked by the user"). The only error a
 * provider adapter should throw when it is certain the message was not
 * accepted — see src/server/messaging/types.ts.
 */
export class MessagingProviderRejectedError extends Error {
  constructor(provider: string, message: string) {
    super(`Messaging provider "${provider}" rejected the message: ${message}`);
    this.name = "MessagingProviderRejectedError";
  }
}

/**
 * The provider call failed in a way that isn't a confirmed rejection —
 * network error, an unrecognized exception, or anything else that doesn't
 * tell us whether the message was actually accepted before the failure.
 * Deliberately the default classification — see
 * docs/integration-architecture.md#messaging.
 */
export class MessagingProviderUnknownError extends Error {
  constructor(provider: string, message: string) {
    super(`Messaging provider "${provider}" outcome is unknown: ${message}`);
    this.name = "MessagingProviderUnknownError";
  }
}
