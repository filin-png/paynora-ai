import { env, type Env } from "@/lib/env";
import { BillingDisabledError, BillingProviderNotImplementedError } from "./errors";
import type { BillingProvider } from "./types";

/** True when `BILLING_PROVIDER` selects anything other than "none". */
export function isBillingEnabled(): boolean {
  return env.BILLING_PROVIDER !== "none";
}

/**
 * Resolves the BillingProvider for the configured `BILLING_PROVIDER` — the
 * one place that knows Stripe/YooKassa (or any future billing vendor)
 * exist. `stripe`/`yookassa` are recognized but have no real adapter yet
 * (no production-safe way to build one without a real merchant account —
 * see docs/integration-architecture.md#billing); selecting either resolves
 * to a clear, typed error, the same precedent as
 * src/server/ai/service.ts's `gigachat`/`yandex`.
 *
 * Takes an explicit `name` (defaulting to `env.BILLING_PROVIDER`) rather
 * than reading the env singleton unconditionally — the same shape as
 * src/server/ai/service.ts's `resolveProviderByName`, chosen here (unlike
 * src/server/email/service.ts's parameterless `resolveEmailProvider`)
 * because there is no real adapter and no call site yet to exercise this
 * through env mutation; a direct parameter keeps it unit-testable without
 * mocking the env module. See service.test.ts.
 */
export function resolveBillingProvider(name: Env["BILLING_PROVIDER"] = env.BILLING_PROVIDER): BillingProvider {
  if (name === "none") throw new BillingDisabledError();
  throw new BillingProviderNotImplementedError(name);
}
