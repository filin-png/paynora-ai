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
 * A billing vendor has a real adapter (Phase 20's `yookassa`) but this
 * deployment hasn't set the credentials it needs — distinct from
 * `BillingProviderNotImplementedError` (no adapter exists at all): this
 * one means "add YUKASSA_SHOP_ID/YUKASSA_SECRET_KEY", not "wait for a
 * future phase". env.ts's own schema already requires these once
 * `BILLING_PROVIDER=yookassa`, so this is defense-in-depth, not the
 * primary way a misconfiguration is caught.
 */
export class BillingProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`Billing provider "${provider}" is missing required credentials for this deployment`);
    this.name = "BillingProviderNotConfiguredError";
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
