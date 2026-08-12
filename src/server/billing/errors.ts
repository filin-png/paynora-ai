/** Billing is turned off (BILLING_PROVIDER=none, the default) or has no configured provider. */
export class BillingDisabledError extends Error {
  constructor() {
    super("Billing is disabled (BILLING_PROVIDER=none)");
    this.name = "BillingDisabledError";
  }
}

/**
 * A billing vendor is recognized (selectable via `BILLING_PROVIDER`) but
 * has no real adapter yet — same precedent as
 * src/server/ai/service.ts's `gigachat`/`yandex` handling. Selecting one
 * resolves to this clear, typed error rather than silently doing nothing.
 */
export class BillingProviderNotImplementedError extends Error {
  constructor(provider: string) {
    super(`Billing provider "${provider}" is not implemented yet — see docs/integration-architecture.md#billing`);
    this.name = "BillingProviderNotImplementedError";
  }
}

/**
 * A webhook delivery failed authenticity verification (bad/missing
 * signature). Never include the raw signature, secret, or full request
 * body in this error's message — see docs/integration-architecture.md
 * #secrets.
 */
export class BillingWebhookVerificationError extends Error {
  constructor(provider: string) {
    super(`Billing provider "${provider}" webhook failed signature verification`);
    this.name = "BillingWebhookVerificationError";
  }
}
