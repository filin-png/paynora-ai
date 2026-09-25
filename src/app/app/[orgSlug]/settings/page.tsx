import Link from "next/link";
import { CircleCheck, CircleHelp, CircleOff } from "lucide-react";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmActionButton } from "@/components/ui/confirm-action-button";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { getDictionary, type Dictionary } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/get-locale";
import { cn } from "@/lib/utils";
import { getCookieConsent } from "@/lib/privacy/get-cookie-consent";
import { getReadinessState } from "@/server/onboarding/readiness";
import { getAccountDeletionWarnings } from "@/server/auth/account-deletion";
import type { ProviderHealthStatus } from "@/server/providers/types";
import { getProviderRegistrySnapshot, getProviderVendorBreakdown } from "@/server/providers/registry";
import { getOrganizationPrivacySettings, listOrganizationMembers } from "@/server/tenancy/organizations";
import { listPendingInvitations } from "@/server/tenancy/invitations";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { BillingTab } from "./billing-tab";
import { clearDemoDataAction, seedDemoDataAction } from "./demo-data-actions";
import { InviteMemberForm } from "./invite-member-form";
import { PendingInvitationsList } from "./pending-invitations-list";
import { deleteAccountAction } from "./account-actions";
import { setAnalyticsEnabledAction } from "./privacy-actions";
import { SupportForm } from "./support-form";
import { RenameOrganizationForm } from "./rename-organization-form";

function healthDisplay(t: Dictionary["settings"]): Record<ProviderHealthStatus, { label: string; tone: NonNullable<BadgeProps["tone"]>; icon: typeof CircleCheck }> {
  return {
    HEALTHY: { label: t.healthConfigured, tone: "success", icon: CircleCheck },
    DEGRADED: { label: t.healthDegraded, tone: "warning", icon: CircleHelp },
    DOWN: { label: t.healthDown, tone: "danger", icon: CircleOff },
    DISABLED: { label: t.healthNotConfigured, tone: "neutral", icon: CircleOff },
    UNKNOWN: { label: t.healthNotAvailableYet, tone: "neutral", icon: CircleHelp },
  };
}

const VENDOR_LABEL: Record<string, string> = {
  openrouter: "OpenRouter",
  mistral: "Mistral",
  smtp: "SMTP",
  telegram: "Telegram",
  posthog: "PostHog",
  anthropic: "Anthropic",
};

function vendorGroupLabel(t: Dictionary["settings"]): Record<"ai" | "email" | "messaging", string> {
  return {
    ai: t.groupAi,
    email: t.groupEmail,
    messaging: t.groupMessaging,
  };
}

const TABS = ["general", "members", "integrations", "security", "privacy", "billing", "readiness"] as const;
type SettingsTab = (typeof TABS)[number];

export default async function OrganizationSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { orgSlug } = await params;
  const { tab: rawTab } = await searchParams;
  const tab: SettingsTab = TABS.includes(rawTab as SettingsTab) ? (rawTab as SettingsTab) : "general";
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = dict.settings;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t.title} description={context.organization.name} />

      <Tabs
        items={[
          { href: `/app/${orgSlug}/settings`, label: t.tabGeneral, active: tab === "general" },
          { href: `/app/${orgSlug}/settings?tab=members`, label: t.tabMembers, active: tab === "members" },
          { href: `/app/${orgSlug}/settings?tab=integrations`, label: t.tabIntegrations, active: tab === "integrations" },
          { href: `/app/${orgSlug}/settings?tab=security`, label: t.tabSecurity, active: tab === "security" },
          { href: `/app/${orgSlug}/settings?tab=privacy`, label: t.tabPrivacy, active: tab === "privacy" },
          { href: `/app/${orgSlug}/settings?tab=billing`, label: t.tabBilling, active: tab === "billing" },
          { href: `/app/${orgSlug}/settings?tab=readiness`, label: t.tabReadiness, active: tab === "readiness" },
        ]}
      />

      {tab === "general" ? <GeneralTab orgSlug={orgSlug} name={context.organization.name} role={context.role} t={t} /> : null}
      {tab === "members" ? (
        <MembersTab organizationId={context.organization.id} orgSlug={orgSlug} role={context.role} t={t} />
      ) : null}
      {tab === "integrations" ? <IntegrationsTab /> : null}
      {tab === "security" ? <SecurityTab email={context.user.email} role={context.role} t={t} /> : null}
      {tab === "privacy" ? (
        <PrivacyTab orgSlug={orgSlug} organizationId={context.organization.id} userId={context.user.id} role={context.role} t={t} />
      ) : null}
      {tab === "billing" ? (
        <BillingTab organizationId={context.organization.id} orgSlug={orgSlug} role={context.role} />
      ) : null}
      {tab === "readiness" ? <ReadinessTab organizationId={context.organization.id} role={context.role} t={t} /> : null}
    </div>
  );
}

async function GeneralTab({
  orgSlug,
  name,
  role,
  t,
}: {
  orgSlug: string;
  name: string;
  role: string;
  t: Dictionary["settings"];
}) {
  if (role !== "OWNER") {
    return <p className="text-sm text-muted">{t.ownerOnly}</p>;
  }
  const boundSeed = seedDemoDataAction.bind(null, orgSlug);
  const boundClear = clearDemoDataAction.bind(null, orgSlug);
  return (
    <div className="flex flex-col gap-4">
      <Card className="max-w-md p-6">
        <p className="text-sm font-semibold text-foreground">{t.orgNameLabel}</p>
        <RenameOrganizationForm orgSlug={orgSlug} currentName={name} />
      </Card>

      <Card className="max-w-md p-6">
        <p className="text-sm font-semibold text-foreground">{t.sampleDataLabel}</p>
        <p className="mt-1 text-xs text-muted">{t.sampleDataDescription}</p>
        <div className="mt-4 flex gap-2">
          <form action={boundSeed}>
            <Button type="submit" variant="outline" size="sm">
              {t.addSampleData}
            </Button>
          </form>
          <ConfirmActionButton
            trigger={
              <button type="button" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                {t.removeSampleData}
              </button>
            }
            action={boundClear}
            confirmTitle={t.removeSampleDataConfirmTitle}
            confirmDescription={t.removeSampleDataConfirmDescription}
            confirmLabel={t.removeSampleData}
          />
        </div>
      </Card>

      <Card className="max-w-md p-6">
        <p className="text-sm font-semibold text-foreground">{t.exportDataLabel}</p>
        <p className="mt-1 text-xs text-muted">{t.exportDataDescription}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a href={`/api/organizations/${orgSlug}/export/customers`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            {t.customersCsv}
          </a>
          <a href={`/api/organizations/${orgSlug}/export/invoices`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            {t.invoicesCsv}
          </a>
          <a href={`/api/organizations/${orgSlug}/export/payments`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            {t.paymentsCsv}
          </a>
        </div>
      </Card>
    </div>
  );
}

async function MembersTab({
  organizationId,
  orgSlug,
  role,
  t,
}: {
  organizationId: string;
  orgSlug: string;
  role: string;
  t: Dictionary["settings"];
}) {
  const [members, pendingInvitations] = await Promise.all([
    listOrganizationMembers(organizationId),
    role === "OWNER" ? listPendingInvitations(organizationId) : Promise.resolve([]),
  ]);

  return (
    <div className="flex flex-col gap-4">
      {role === "OWNER" ? (
        <Card className="p-6">
          <p className="text-sm font-semibold text-foreground">{t.inviteMember}</p>
          <div className="mt-4">
            <InviteMemberForm orgSlug={orgSlug} />
          </div>
          <PendingInvitationsList
            orgSlug={orgSlug}
            invitations={pendingInvitations.map((invitation) => ({
              id: invitation.id,
              email: invitation.email,
              role: invitation.role,
              expiresAt: invitation.expiresAt.toISOString(),
            }))}
          />
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <ul className="divide-y divide-border">
          {members.map((member) => (
            <li key={member.userId} className="flex items-center justify-between px-5 py-3.5 text-sm">
              <span className="text-foreground">{member.name ?? member.email}</span>
              <Badge tone={member.role === "OWNER" ? "info" : "neutral"}>{member.role === "OWNER" ? t.owner : t.member}</Badge>
            </li>
          ))}
        </ul>
      </Card>

      {role === "OWNER" && members.length === 1 && pendingInvitations.length === 0 ? (
        <p className="text-xs text-muted">{t.onlyMemberNote}</p>
      ) : null}
    </div>
  );
}

/**
 * Real data, not a mockup: reads the same provider registry Phase 6
 * built for a future Control Center (src/server/providers/registry.ts).
 * Never renders a credential — the snapshot itself has no field for one.
 * See docs/integration-architecture.md#provider-registry.
 */
async function IntegrationsTab() {
  const dict = getDictionary(await getLocale());
  const categoryLabel = dict.settingsIntegrations;
  const t = dict.settings;
  const HEALTH_DISPLAY = healthDisplay(t);
  const VENDOR_GROUP_LABEL = vendorGroupLabel(t);
  const snapshot = getProviderRegistrySnapshot();
  const vendors = getProviderVendorBreakdown();
  const vendorsByGroup = {
    ai: vendors.filter((v) => v.category === "ai"),
    email: vendors.filter((v) => v.category === "email"),
    messaging: vendors.filter((v) => v.category === "messaging"),
  } as const;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">
        {t.deploymentProfileLabel} <span className="font-medium text-foreground">{snapshot.deploymentProfile}</span>.{" "}
        {t.deploymentProfileNote}
      </p>

      {(["ai", "email", "messaging"] as const).map((group) => (
        <div key={group} className="flex flex-col gap-2">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{VENDOR_GROUP_LABEL[group]}</p>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-border">
              {vendorsByGroup[group].map((vendor) => (
                <li key={vendor.vendor} className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm">
                  <div>
                    <p className="font-medium text-foreground">{VENDOR_LABEL[vendor.vendor] ?? vendor.vendor}</p>
                    {vendor.active ? <p className="text-xs text-muted-foreground">{t.currentlySelected}</p> : null}
                  </div>
                  <Badge tone={vendor.configured ? "success" : "neutral"}>
                    {vendor.configured ? t.configured : t.notConfigured}
                  </Badge>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ))}

      {(["billing", "wallet", "analytics", "webSearch"] as const).map((category) => (
        <div key={category} className="flex flex-col gap-2">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{categoryLabel[category]}</p>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-border">
              {snapshot.entries
                .filter((entry) => entry.category === category)
                .map((entry) => {
                  const health = HEALTH_DISPLAY[entry.health];
                  return (
                    <li key={entry.category} className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm">
                      <div>
                        <p className="font-medium text-foreground">{categoryLabel[entry.category]}</p>
                        <p className="text-xs text-muted-foreground">
                          {entry.vendor === "none" ? t.notConnected : entry.vendor}
                          {!entry.implemented && entry.vendor !== "none" ? t.notImplementedYet : ""}
                        </p>
                      </div>
                      <Badge tone={health.tone}>{health.label}</Badge>
                    </li>
                  );
                })}
            </ul>
          </Card>
        </div>
      ))}
    </div>
  );
}

function SecurityTab({ email, role, t }: { email: string; role: string; t: Dictionary["settings"] }) {
  return (
    <Card className="flex flex-col divide-y divide-border p-0">
      <div className="flex items-center justify-between px-5 py-3.5 text-sm">
        <span className="text-muted-foreground">{t.signedInAs}</span>
        <span className="font-medium text-foreground">{email}</span>
      </div>
      <div className="flex items-center justify-between px-5 py-3.5 text-sm">
        <span className="text-muted-foreground">{t.yourRole}</span>
        <Badge tone={role === "OWNER" ? "info" : "neutral"}>{role === "OWNER" ? t.owner : t.member}</Badge>
      </div>
      <div className="flex items-center justify-between px-5 py-3.5 text-sm">
        <span className="text-muted-foreground">{t.everyActionReauthorized}</span>
        <Badge tone="success">{t.alwaysOn}</Badge>
      </div>
    </Card>
  );
}

/**
 * Real controls, never fake toggles (Phase 15A) — Analytics reads and
 * writes `Organization.analyticsEnabled`, the exact column
 * `src/server/analytics/events.ts#trackEvent` checks before every event
 * fires. Cookie consent status is read-only display here — the actual
 * choice is made via the banner (`src/components/cookie-consent-banner.tsx`);
 * this only shows what was last recorded. See
 * docs/privacy-data-inventory.md and docs/privacy-policy.md.
 */
async function PrivacyTab({
  orgSlug,
  organizationId,
  userId,
  role,
  t,
}: {
  orgSlug: string;
  organizationId: string;
  userId: string;
  role: string;
  t: Dictionary["settings"];
}) {
  const [{ analyticsEnabled }, cookieConsent, { soleOwnerOfOrganizations }] = await Promise.all([
    getOrganizationPrivacySettings(organizationId),
    getCookieConsent(),
    getAccountDeletionWarnings(userId),
  ]);
  const cookieConsentLabel =
    cookieConsent === "accepted" ? t.consentAccepted : cookieConsent === "rejected" ? t.consentRejected : t.consentNotDecided;
  const deleteConfirmDescription =
    soleOwnerOfOrganizations.length > 0
      ? t.deleteAccountSoleOwnerDescription.replace("{orgs}", soleOwnerOfOrganizations.map((org) => org.name).join(", "))
      : t.deleteAccountDescription;

  return (
    <div className="flex flex-col gap-4">
      <Card className="max-w-md p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-foreground">{t.analyticsLabel}</p>
            <p className="mt-1 text-xs text-muted">{t.analyticsDescription}</p>
          </div>
          <Badge tone={analyticsEnabled ? "success" : "neutral"}>{analyticsEnabled ? t.statusEnabled : t.statusDisabled}</Badge>
        </div>
        {role === "OWNER" ? (
          <form action={setAnalyticsEnabledAction.bind(null, orgSlug, !analyticsEnabled)} className="mt-4">
            <Button type="submit" variant="outline" size="sm">
              {analyticsEnabled ? t.disableAnalytics : t.enableAnalytics}
            </Button>
          </form>
        ) : (
          <p className="mt-4 text-xs text-muted">{t.onlyOwnerCanChange}</p>
        )}
      </Card>

      <Card className="max-w-md p-6">
        <p className="text-sm font-semibold text-foreground">{t.cookiesLabel}</p>
        <p className="mt-1 text-xs text-muted">{t.cookiesDescription}</p>
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t.analyticsCookieConsent}</span>
          <Badge tone={cookieConsent === "accepted" ? "success" : cookieConsent === "rejected" ? "neutral" : "warning"}>
            {cookieConsentLabel}
          </Badge>
        </div>
      </Card>

      <Card className="max-w-md p-6">
        <p className="text-sm font-semibold text-foreground">{t.dataAndAccount}</p>
        <p className="mt-1 text-xs text-muted">
          {t.dataAndAccountDescription}{" "}
          <Link href="/privacy-policy" className="text-primary hover:underline">
            {t.privacyPolicyLink}
          </Link>{" "}
          {t.forWhatEachDoes}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <a href="/api/account/export" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            {t.exportMyData}
          </a>
          <ConfirmActionButton
            trigger={
              <Button type="button" variant="destructive" size="sm">
                {t.deleteMyAccount}
              </Button>
            }
            action={deleteAccountAction}
            confirmTitle={t.deleteAccountConfirmTitle}
            confirmDescription={deleteConfirmDescription}
            confirmLabel={t.deleteAccount}
          />
        </div>
      </Card>

      <Card className="max-w-md p-6">
        <p className="text-sm font-semibold text-foreground">{t.contactSupport}</p>
        <p className="mt-1 text-xs text-muted">{t.contactSupportDescription}</p>
        <div className="mt-4">
          <SupportForm orgSlug={orgSlug} />
        </div>
      </Card>
    </div>
  );
}

/**
 * OWNER-visible product-readiness summary (Phase 11.4 brief, section 6) —
 * all computation lives in src/server/onboarding/readiness.ts so it stays
 * unit-testable independently of this page.
 */
async function ReadinessTab({ organizationId, role, t }: { organizationId: string; role: string; t: Dictionary["settings"] }) {
  if (role !== "OWNER") {
    return <p className="text-sm text-muted">{t.ownerOnlyReadiness}</p>;
  }

  const { checks, readyCount } = await getReadinessState(organizationId);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        {t.readinessSummary.replace("{ready}", String(readyCount)).replace("{total}", String(checks.length))}
      </p>
      <Card className="overflow-hidden">
        <ul className="divide-y divide-border">
          {checks.map((check) => (
            <li key={check.label} className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm">
              <div>
                <p className="font-medium text-foreground">{check.label}</p>
                <p className="text-xs text-muted-foreground">{check.detail}</p>
              </div>
              <Badge tone={check.ready ? "success" : "neutral"}>{check.ready ? t.ready : t.notReady}</Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
