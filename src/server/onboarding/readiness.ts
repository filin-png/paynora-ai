import { env } from "@/lib/env";
import { getOrganizationEntitlements } from "@/server/billing/entitlements";
import { getProviderRegistrySnapshot } from "@/server/providers/registry";
import type { ProviderHealthStatus } from "@/server/providers/types";

export type ReadinessCheck = {
  label: string;
  ready: boolean;
  detail: string;
};

export type ReadinessState = {
  checks: ReadinessCheck[];
  readyCount: number;
};

/**
 * OWNER-visible product-readiness summary (Phase 11.4 brief, section 6).
 * Every value here comes from a primitive that already refuses to expose a
 * secret: `getProviderRegistrySnapshot` (src/server/providers/registry.ts)
 * reports only vendor/health booleans, never a credential, and
 * `getOrganizationEntitlements` reports plan state, never a billing-provider
 * secret. The one raw environment read here is `APP_BASE_URL`, a public
 * origin, not a secret — see registry.test.ts's own "never includes a
 * secret value" proof for the provider half of this guarantee.
 */
export async function getReadinessState(organizationId: string): Promise<ReadinessState> {
  const snapshot = getProviderRegistrySnapshot();
  const { plan, status, entitlements } = await getOrganizationEntitlements(organizationId);
  const aiEntry = snapshot.entries.find((entry) => entry.category === "ai");
  const emailEntry = snapshot.entries.find((entry) => entry.category === "email");
  const isLocalBaseUrl = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(env.APP_BASE_URL);

  const healthLabel = (health: ProviderHealthStatus): string =>
    health === "HEALTHY" ? "Configured" : health === "DISABLED" ? "Not configured" : health;

  const checks: ReadinessCheck[] = [
    {
      label: "AI provider",
      ready: aiEntry?.health === "HEALTHY",
      detail: aiEntry && aiEntry.vendor !== "none" ? `${aiEntry.vendor} — ${healthLabel(aiEntry.health)}` : "Not configured",
    },
    {
      label: "Transactional email",
      ready: emailEntry?.health === "HEALTHY",
      detail:
        emailEntry && emailEntry.vendor !== "none" ? `${emailEntry.vendor} — ${healthLabel(emailEntry.health)}` : "Not configured",
    },
    {
      // A distinct signal from "Transactional email" above: env.ts's
      // cross-field validation already guarantees PAYNORA_EMAIL_FROM is
      // set whenever EMAIL_PROVIDER selects a real vendor (the process
      // refuses to boot otherwise — see src/lib/env.ts), so this is
      // never false while email is HEALTHY above; it's still worth its
      // own row so "why is email not ready" is never ambiguous between
      // "no provider selected" and "provider selected, sender missing"
      // for anyone reading this before that invariant is memorized.
      label: "Sender address",
      ready: Boolean(env.PAYNORA_EMAIL_FROM),
      detail: env.PAYNORA_EMAIL_FROM ? env.PAYNORA_EMAIL_FROM : "PAYNORA_EMAIL_FROM is not set",
    },
    {
      label: "Application base URL",
      ready: !isLocalBaseUrl,
      detail: isLocalBaseUrl
        ? `${env.APP_BASE_URL} — set APP_BASE_URL to your public domain before inviting real users`
        : env.APP_BASE_URL,
    },
    {
      label: "Collections automation",
      ready: entitlements.collectionsAutomationEnabled,
      detail: entitlements.collectionsAutomationEnabled ? "Available on this plan" : "Not available on the current plan",
    },
    {
      // Deployment-wide, not org-specific — like "Application base URL"
      // above. `env.ts`'s cross-field validation already guarantees
      // AUTOMATION_CRON_SECRET is set whenever AUTOMATION_ENABLED is
      // true, so checking both is defensive-but-honest rather than
      // strictly necessary. This only reports whether the internal
      // scheduler endpoint (POST /internal/automation/tick) is
      // configured to accept requests — not whether an external
      // scheduler is actually calling it on an interval, which is a
      // separate, deployment-operational fact this app cannot observe;
      // see GET /internal/automation/health for that heartbeat.
      label: "Automation scheduler",
      ready: env.AUTOMATION_ENABLED && Boolean(env.AUTOMATION_CRON_SECRET),
      detail: env.AUTOMATION_ENABLED
        ? "Enabled — configure a scheduler to call POST /internal/automation/tick on an interval"
        : "Disabled for this deployment (AUTOMATION_ENABLED=false)",
    },
    {
      label: "Subscription",
      ready: status === "ACTIVE" || status === "TRIALING",
      detail: `${plan} — ${status}`,
    },
  ];

  return { checks, readyCount: checks.filter((check) => check.ready).length };
}
