import { CircleCheck, CircleHelp, CircleOff } from "lucide-react";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmActionButton } from "@/components/ui/confirm-action-button";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { getDictionary } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/get-locale";
import { cn } from "@/lib/utils";
import { getReadinessState } from "@/server/onboarding/readiness";
import type { ProviderHealthStatus } from "@/server/providers/types";
import { getProviderRegistrySnapshot, getProviderVendorBreakdown } from "@/server/providers/registry";
import { listOrganizationMembers } from "@/server/tenancy/organizations";
import { listPendingInvitations } from "@/server/tenancy/invitations";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { BillingTab } from "./billing-tab";
import { clearDemoDataAction, seedDemoDataAction } from "./demo-data-actions";
import { InviteMemberForm } from "./invite-member-form";
import { PendingInvitationsList } from "./pending-invitations-list";
import { RenameOrganizationForm } from "./rename-organization-form";

const HEALTH_DISPLAY: Record<ProviderHealthStatus, { label: string; tone: NonNullable<BadgeProps["tone"]>; icon: typeof CircleCheck }> = {
  HEALTHY: { label: "Configured", tone: "success", icon: CircleCheck },
  DEGRADED: { label: "Degraded", tone: "warning", icon: CircleHelp },
  DOWN: { label: "Down", tone: "danger", icon: CircleOff },
  DISABLED: { label: "Not configured", tone: "neutral", icon: CircleOff },
  UNKNOWN: { label: "Not available yet", tone: "neutral", icon: CircleHelp },
};

const VENDOR_LABEL: Record<string, string> = {
  openrouter: "OpenRouter",
  mistral: "Mistral",
  smtp: "SMTP",
  telegram: "Telegram",
  posthog: "PostHog",
  anthropic: "Anthropic",
};

const VENDOR_GROUP_LABEL: Record<"ai" | "email" | "messaging", string> = {
  ai: "AI",
  email: "Email",
  messaging: "Messaging",
};

const TABS = ["general", "members", "integrations", "security", "billing", "readiness"] as const;
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

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Settings" description={context.organization.name} />

      <Tabs
        items={[
          { href: `/app/${orgSlug}/settings`, label: "General", active: tab === "general" },
          { href: `/app/${orgSlug}/settings?tab=members`, label: "Members", active: tab === "members" },
          { href: `/app/${orgSlug}/settings?tab=integrations`, label: "Integrations", active: tab === "integrations" },
          { href: `/app/${orgSlug}/settings?tab=security`, label: "Security", active: tab === "security" },
          { href: `/app/${orgSlug}/settings?tab=billing`, label: "Billing", active: tab === "billing" },
          { href: `/app/${orgSlug}/settings?tab=readiness`, label: "Readiness", active: tab === "readiness" },
        ]}
      />

      {tab === "general" ? <GeneralTab orgSlug={orgSlug} name={context.organization.name} role={context.role} /> : null}
      {tab === "members" ? (
        <MembersTab organizationId={context.organization.id} orgSlug={orgSlug} role={context.role} />
      ) : null}
      {tab === "integrations" ? <IntegrationsTab /> : null}
      {tab === "security" ? <SecurityTab email={context.user.email} role={context.role} /> : null}
      {tab === "billing" ? <BillingTab organizationId={context.organization.id} /> : null}
      {tab === "readiness" ? <ReadinessTab organizationId={context.organization.id} role={context.role} /> : null}
    </div>
  );
}

async function GeneralTab({ orgSlug, name, role }: { orgSlug: string; name: string; role: string }) {
  if (role !== "OWNER") {
    return <p className="text-sm text-muted">Only an organization owner can change these settings.</p>;
  }
  const boundSeed = seedDemoDataAction.bind(null, orgSlug);
  const boundClear = clearDemoDataAction.bind(null, orgSlug);
  return (
    <div className="flex flex-col gap-4">
      <Card className="max-w-md p-6">
        <p className="text-sm font-semibold text-foreground">Organization name</p>
        <RenameOrganizationForm orgSlug={orgSlug} currentName={name} />
      </Card>

      <Card className="max-w-md p-6">
        <p className="text-sm font-semibold text-foreground">Sample data</p>
        <p className="mt-1 text-xs text-muted">
          Add a handful of fictional B2B customers and invoices — current, overdue, partially paid, and paid — to try
          out PAYNORA before importing your real data. Clearly marked and safe to remove at any time.
        </p>
        <div className="mt-4 flex gap-2">
          <form action={boundSeed}>
            <Button type="submit" variant="outline" size="sm">
              Add sample data
            </Button>
          </form>
          <ConfirmActionButton
            trigger={
              <button type="button" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                Remove sample data
              </button>
            }
            action={boundClear}
            confirmTitle="Remove sample data?"
            confirmDescription="Archives every sample customer created by this action and cancels their still-open, unpaid sample invoices. Sample invoices that already have a recorded payment are kept as history, exactly like any other invoice."
            confirmLabel="Remove sample data"
          />
        </div>
      </Card>
    </div>
  );
}

async function MembersTab({
  organizationId,
  orgSlug,
  role,
}: {
  organizationId: string;
  orgSlug: string;
  role: string;
}) {
  const [members, pendingInvitations] = await Promise.all([
    listOrganizationMembers(organizationId),
    role === "OWNER" ? listPendingInvitations(organizationId) : Promise.resolve([]),
  ]);

  return (
    <div className="flex flex-col gap-4">
      {role === "OWNER" ? (
        <Card className="p-6">
          <p className="text-sm font-semibold text-foreground">Invite a member</p>
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
              <Badge tone={member.role === "OWNER" ? "info" : "neutral"}>{member.role === "OWNER" ? "Owner" : "Member"}</Badge>
            </li>
          ))}
        </ul>
      </Card>

      {role === "OWNER" && members.length === 1 && pendingInvitations.length === 0 ? (
        <p className="text-xs text-muted">
          You&rsquo;re the only member of this organization. Invite a teammate above to share reviewing Action Center
          recommendations and following up on overdue invoices.
        </p>
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
        Deployment profile: <span className="font-medium text-foreground">{snapshot.deploymentProfile}</span>. Configured
        via environment variables — see DEPLOYMENT.md. Never shows a secret value; this only reflects whether the
        required variables are present.
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
                    {vendor.active ? <p className="text-xs text-muted-foreground">Currently selected</p> : null}
                  </div>
                  <Badge tone={vendor.configured ? "success" : "neutral"}>
                    {vendor.configured ? "Configured" : "Not configured"}
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
                          {entry.vendor === "none" ? "Not connected" : entry.vendor}
                          {!entry.implemented && entry.vendor !== "none" ? " — not implemented yet" : ""}
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

function SecurityTab({ email, role }: { email: string; role: string }) {
  return (
    <Card className="flex flex-col divide-y divide-border p-0">
      <div className="flex items-center justify-between px-5 py-3.5 text-sm">
        <span className="text-muted-foreground">Signed in as</span>
        <span className="font-medium text-foreground">{email}</span>
      </div>
      <div className="flex items-center justify-between px-5 py-3.5 text-sm">
        <span className="text-muted-foreground">Your role in this organization</span>
        <Badge tone={role === "OWNER" ? "info" : "neutral"}>{role === "OWNER" ? "Owner" : "Member"}</Badge>
      </div>
      <div className="flex items-center justify-between px-5 py-3.5 text-sm">
        <span className="text-muted-foreground">Every action is re-authorized server-side</span>
        <Badge tone="success">Always on</Badge>
      </div>
    </Card>
  );
}

/**
 * OWNER-visible product-readiness summary (Phase 11.4 brief, section 6) —
 * all computation lives in src/server/onboarding/readiness.ts so it stays
 * unit-testable independently of this page.
 */
async function ReadinessTab({ organizationId, role }: { organizationId: string; role: string }) {
  if (role !== "OWNER") {
    return <p className="text-sm text-muted">Only an organization owner can view product readiness.</p>;
  }

  const { checks, readyCount } = await getReadinessState(organizationId);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        {readyCount} of {checks.length} readiness checks pass. This never shows a credential or environment value —
        only whether something is configured. See DEPLOYMENT.md to configure a provider.
      </p>
      <Card className="overflow-hidden">
        <ul className="divide-y divide-border">
          {checks.map((check) => (
            <li key={check.label} className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm">
              <div>
                <p className="font-medium text-foreground">{check.label}</p>
                <p className="text-xs text-muted-foreground">{check.detail}</p>
              </div>
              <Badge tone={check.ready ? "success" : "neutral"}>{check.ready ? "Ready" : "Not ready"}</Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
