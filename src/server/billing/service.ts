import { env, type Env } from "@/lib/env";
import { BillingDisabledError, BillingProviderNotConfiguredError, BillingProviderNotImplementedError } from "./errors";
import { createYooKassaProvider, DEFAULT_ALLOWED_CIDRS } from "./providers/yookassa";
import type { BillingProvider } from "./types";

/** True when `BILLING_PROVIDER` selects anything other than "none". */
export function isBillingEnabled(): boolean {
  return env.BILLING_PROVIDER !== "none";
}

/**
 * Resolves the BillingProvider for the configured `BILLING_PROVIDER` — the
 * one place that knows Stripe/YooKassa (or any future billing vendor)
 * exist. `yookassa` has a real adapter as of Phase 20
 * (src/server/billing/providers/yookassa.ts); `stripe` remains recognized
 * but not implemented, the same precedent as src/server/ai/service.ts's
 * `gigachat`/`yandex`.
 *
 * Takes an explicit `name` (defaulting to `env.BILLING_PROVIDER`) rather
 * than reading the env singleton unconditionally — the same shape as
 * src/server/ai/service.ts's `resolveProviderByName` — a direct parameter
 * keeps this unit-testable without mocking the env module. See
 * service.test.ts.
 */
export function resolveBillingProvider(name: Env["BILLING_PROVIDER"] = env.BILLING_PROVIDER): BillingProvider {
  if (name === "none") throw new BillingDisabledError();
  if (name === "yookassa") {
    if (!env.YUKASSA_SHOP_ID || !env.YUKASSA_SECRET_KEY) {
      // env.ts's own schema already requires these when BILLING_PROVIDER=yookassa,
      // so this should be unreachable in a validly-parsed Env — a defensive
      // check anyway, never a silent fallback to a demo/fake credential.
      throw new BillingProviderNotConfiguredError(name);
    }
    return createYooKassaProvider({
      shopId: env.YUKASSA_SHOP_ID,
      secretKey: env.YUKASSA_SECRET_KEY,
      allowedCidrs: env.YUKASSA_WEBHOOK_IP_ALLOWLIST
        ? env.YUKASSA_WEBHOOK_IP_ALLOWLIST.split(",").map((cidr) => cidr.trim())
        : DEFAULT_ALLOWED_CIDRS,
    });
  }
  throw new BillingProviderNotImplementedError(name);
}
