import { env } from "@/lib/env";
import type {
  DeploymentProfile,
  ProviderCategory,
  ProviderHealthStatus,
  ProviderRegistryEntry,
  ProviderRegistrySnapshot,
} from "./types";

/**
 * Vendors this codebase currently recognizes per category, and whether a
 * real adapter exists behind the recognized value — kept as one small,
 * readable table rather than scattered across each category's own
 * service.ts, so "is X actually implemented" has one authoritative answer
 * instead of needing to be inferred from a switch statement per category.
 * Update this table, not just the adapter, whenever a new vendor is
 * recognized or a "not implemented" one gets a real adapter.
 */
const IMPLEMENTED_VENDORS: Record<ProviderCategory, Record<string, boolean>> = {
  ai: { none: true, openrouter: true, mistral: true, gigachat: false, yandex: false },
  email: { none: true, smtp: true },
  messaging: { none: true, telegram: true },
  billing: { none: true, stripe: false, yookassa: false },
  // Phase 13 — see docs/wallet-architecture.md#production-integration-point.
  // "test" is deliberately absent here: it is never a WALLET_PROVIDER
  // value, only a direct test-only import (src/server/wallet/providers/fake.ts).
  wallet: { none: true, coinbase: false, privy: false },
};

const CAPABILITIES: Record<ProviderCategory, Record<string, readonly string[]>> = {
  ai: {
    none: [],
    openrouter: ["structured-generation"],
    mistral: ["structured-generation"],
    gigachat: [],
    yandex: [],
  },
  email: { none: [], smtp: ["send"] },
  messaging: { none: [], telegram: ["send"] },
  billing: { none: [], stripe: [], yookassa: [] },
  wallet: { none: [], coinbase: [], privy: [] },
};

/** Exported for direct unit testing — see registry.test.ts. */
export function resolveHealth(vendor: string, implemented: boolean): ProviderHealthStatus {
  if (vendor === "none") return "DISABLED";
  if (!implemented) return "UNKNOWN";
  // Configuration-derived readiness only — no live network probe is ever
  // performed here (a "health check" that sends a real email or spends a
  // paid AI call would be a side effect, not a check). A vendor that's
  // selected and has a real adapter is reported HEALTHY on the assumption
  // its own required configuration already passed Zod validation at boot
  // (src/lib/env.ts) — if it hadn't, the process would never have started.
  return "HEALTHY";
}

function entry(category: ProviderCategory, vendor: string): ProviderRegistryEntry {
  const implemented = IMPLEMENTED_VENDORS[category][vendor] ?? false;
  return {
    category,
    vendor,
    enabled: vendor !== "none",
    implemented,
    health: resolveHealth(vendor, implemented),
    capabilities: CAPABILITIES[category][vendor] ?? [],
  };
}

/**
 * The one place that turns current environment configuration into a
 * reportable snapshot across every provider category — intended for a
 * future PAYNORA Control Center page and for this phase's own tests, not
 * currently rendered anywhere. Pure and synchronous: no I/O, no network
 * call, safe to call as often as needed. See
 * docs/integration-architecture.md#provider-registry.
 */
export function getProviderRegistrySnapshot(): ProviderRegistrySnapshot {
  return {
    deploymentProfile: env.DEPLOYMENT_PROFILE,
    entries: [
      entry("ai", env.AI_PROVIDER),
      entry("email", env.EMAIL_PROVIDER),
      entry("messaging", env.MESSAGING_PROVIDER),
      entry("billing", env.BILLING_PROVIDER),
      entry("wallet", env.WALLET_PROVIDER),
    ],
  };
}

/**
 * Recommended vendor sets per deployment profile, for documentation and a
 * future setup UI — never enforced. Selecting a vendor outside its
 * profile's recommendation is never rejected; this is guidance, not a
 * restriction (see docs/integration-architecture.md#deployment-profiles
 * for why: one codebase, and an operator may have a legitimate reason to
 * mix, e.g. a RU-based team billing through Stripe for an international
 * customer).
 */
const RECOMMENDED_VENDORS: Record<DeploymentProfile, Partial<Record<ProviderCategory, readonly string[]>>> = {
  RU: {
    ai: ["gigachat", "yandex", "openrouter", "mistral"],
    billing: ["yookassa"],
    email: ["smtp"],
    messaging: ["telegram"],
  },
  GLOBAL: {
    ai: ["openrouter", "mistral"],
    billing: ["stripe"],
    email: ["smtp"],
    messaging: ["telegram"],
  },
  LOCAL_TEST: {
    ai: ["none"],
    billing: ["none"],
    email: ["none"],
    messaging: ["none"],
  },
};

export function getRecommendedVendors(profile: DeploymentProfile, category: ProviderCategory): readonly string[] {
  return RECOMMENDED_VENDORS[profile][category] ?? [];
}

export type VendorConfigurationStatus = {
  category: ProviderCategory;
  vendor: string;
  /** Its required env vars are all present — regardless of whether it's the currently *active* selection for its category. */
  configured: boolean;
  /** Whether a real adapter exists for this vendor at all (see IMPLEMENTED_VENDORS above). */
  implemented: boolean;
  /** True when this vendor is the category's current primary or (for AI) fallback selection. */
  active: boolean;
};

/**
 * Per-vendor configured status (Settings -> Integrations, Phase 8) — a
 * finer-grained view than `getProviderRegistrySnapshot`'s one-entry-per-
 * category snapshot, which only reports the currently *active* selection.
 * A deployment can have OPENROUTER_API_KEY set while AI_PROVIDER is
 * "mistral" (e.g. configuring a fallback, or preparing a future switch) —
 * this reports that vendor as configured even though it isn't primary
 * today. Purely a function of which env vars are present; never a network
 * probe, same discipline as resolveHealth. Never returns a secret value,
 * only a boolean.
 */
export function getProviderVendorBreakdown(): readonly VendorConfigurationStatus[] {
  return [
    {
      category: "ai",
      vendor: "openrouter",
      configured: Boolean(env.OPENROUTER_API_KEY && env.OPENROUTER_MODEL),
      implemented: IMPLEMENTED_VENDORS.ai.openrouter,
      active: env.AI_PROVIDER === "openrouter" || env.AI_PROVIDER_FALLBACK === "openrouter",
    },
    {
      category: "ai",
      vendor: "mistral",
      configured: Boolean(env.MISTRAL_API_KEY && env.MISTRAL_MODEL),
      implemented: IMPLEMENTED_VENDORS.ai.mistral,
      active: env.AI_PROVIDER === "mistral" || env.AI_PROVIDER_FALLBACK === "mistral",
    },
    {
      category: "email",
      vendor: "smtp",
      configured: Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASSWORD && env.PAYNORA_EMAIL_FROM),
      implemented: IMPLEMENTED_VENDORS.email.smtp,
      active: env.EMAIL_PROVIDER === "smtp",
    },
    {
      category: "messaging",
      vendor: "telegram",
      configured: Boolean(env.TELEGRAM_BOT_TOKEN),
      implemented: IMPLEMENTED_VENDORS.messaging.telegram,
      active: env.MESSAGING_PROVIDER === "telegram",
    },
  ];
}
