/**
 * Cross-cutting types shared by every provider category (AI, Email,
 * Messaging, Billing, and — documented but not implemented — Storage/
 * Accounting/CRM/Banking). See docs/integration-architecture.md for the
 * full design. Nothing in this file is category-specific; each category
 * keeps its own request/response contract (AIProvider, EmailProvider,
 * MessagingProvider, BillingProvider) in its own directory — this module
 * only describes how those categories are configured, selected, and
 * reported on, not what they do.
 */

/**
 * Which recognized-and-selectable vendor set a deployment is running.
 * Purely descriptive metadata (src/server/providers/registry.ts) — never
 * enforced as a hard restriction. One codebase, different provider
 * configurations; see docs/integration-architecture.md#deployment-profiles.
 */
export type DeploymentProfile = "RU" | "GLOBAL" | "LOCAL_TEST";

/** The provider categories this registry currently knows about. Storage/Accounting/CRM/Banking have no TypeScript interface yet — see docs/integration-architecture.md#not-implemented-boundaries. */
export type ProviderCategory = "ai" | "email" | "messaging" | "billing" | "wallet" | "analytics" | "webSearch";

/**
 * Vendor-neutral health status. Phase 6 never performs a live network
 * probe to determine this (see docs/integration-architecture.md#health-model
 * for why: a "health check" that itself sends an email or calls a paid AI
 * endpoint is a side effect, not a safe check) — every status here is
 * derived from configuration alone. `DEGRADED`/`DOWN` are reserved for a
 * future real health-check mechanism and are never produced today; they
 * exist in the type now so nothing downstream (a future Control Center
 * page) needs a breaking change when that mechanism is added.
 */
export type ProviderHealthStatus = "HEALTHY" | "DEGRADED" | "DOWN" | "DISABLED" | "UNKNOWN";

/**
 * One category's current resolved state, as reported by the registry.
 * `vendor` is the selected value (e.g. `"openrouter"`, `"telegram"`,
 * `"none"`) regardless of whether a real adapter exists for it —
 * `implemented` is what distinguishes "selected and working" from
 * "selected but not implemented yet" (the same recognized-but-unimplemented
 * precedent AI_PROVIDER="gigachat" already established in Phase 3).
 */
export type ProviderRegistryEntry = {
  category: ProviderCategory;
  vendor: string;
  enabled: boolean;
  implemented: boolean;
  health: ProviderHealthStatus;
  capabilities: readonly string[];
};

export type ProviderRegistrySnapshot = {
  deploymentProfile: DeploymentProfile;
  entries: readonly ProviderRegistryEntry[];
};
