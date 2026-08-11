import Link from "next/link";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listCollectionPolicies } from "@/server/collections/policy";
import { getCollectionStatusForInvoice, listActiveCollectionSequences } from "@/server/collections/sequences";
import { prisma } from "@/server/db/client";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import {
  createDefaultPolicyAction,
  pauseSequenceAction,
  resumeSequenceAction,
  runManualAutomationTickAction,
  setAutomationEnabledAction,
  setDefaultPolicyAction,
  setPolicyAutomationModeAction,
  setPolicyEnabledAction,
  stopSequenceAction,
} from "./actions";

const SEQUENCE_STATUS_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  active: "success",
  blocked_uncertain: "warning",
  paused: "neutral",
};

export default async function AutomationPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const organizationId = context.organization.id;
  const isOwner = context.role === "OWNER";

  const [organization, policies, activeSequences] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
    listCollectionPolicies(organizationId),
    listActiveCollectionSequences(organizationId),
  ]);

  const sequenceStatuses = await Promise.all(
    activeSequences.map((sequence) => getCollectionStatusForInvoice(organizationId, sequence.invoiceId)),
  );

  const blockedCount = sequenceStatuses.filter((s) => s.kind === "blocked_uncertain").length;
  const upcomingCount = sequenceStatuses.filter((s) => s.kind === "active").length;

  // Deliberately honest: this page never claims "automation running" —
  // only that the engine exists and, separately, whether the org has
  // opted in. Whether anything actually *calls* runAutomationTick on a
  // schedule is a deployment fact this UI cannot observe — see
  // docs/collections-automation.md#no-fake-scheduler.
  const isDev = process.env.NODE_ENV !== "production";

  return (
    <div className="flex flex-col gap-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Automation</h1>
        <p className="mt-1 text-sm text-muted">
          Collections automation re-checks your overdue invoices on a schedule and prepares (or, if you&rsquo;ve
          explicitly enabled it, sends) payment reminders — see docs/collections-automation.md for exactly how.
        </p>
      </div>

      <div className="rounded-md border border-border p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">
              Organization automation: <Badge tone={organization.automationEnabled ? "success" : "neutral"}>
                {organization.automationEnabled ? "Enabled" : "Disabled"}
              </Badge>
            </p>
            <p className="mt-1 text-xs text-muted">
              The kill switch. When disabled, the scheduler tick does nothing for this organization — manual AR,
              Action Center, and Communications flows are unaffected either way.
            </p>
          </div>
          {isOwner ? (
            <form action={setAutomationEnabledAction.bind(null, orgSlug, !organization.automationEnabled)}>
              <button type="submit" className={cn(buttonVariants({ variant: "outline" }))}>
                {organization.automationEnabled ? "Disable" : "Enable"}
              </button>
            </form>
          ) : null}
        </div>

        <div className="mt-6 grid grid-cols-2 gap-6 sm:grid-cols-4">
          <div>
            <p className="text-xs text-muted">Active sequences</p>
            <p className="mt-1 text-lg font-semibold">{activeSequences.length}</p>
          </div>
          <div>
            <p className="text-xs text-muted">Upcoming actions</p>
            <p className="mt-1 text-lg font-semibold">{upcomingCount}</p>
          </div>
          <div>
            <p className="text-xs text-muted">Blocked (uncertain delivery)</p>
            <p className="mt-1 text-lg font-semibold">{blockedCount}</p>
          </div>
        </div>

        {isDev && isOwner ? (
          <form action={runManualAutomationTickAction.bind(null, orgSlug)} className="mt-6">
            <p className="mb-2 text-xs text-muted">
              Development only — no scheduler is configured to call this automatically in this environment. See
              docs/collections-automation.md#scheduler-deployment for how a real deployment wires up
              POST /internal/automation/tick.
            </p>
            <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              Run automation tick now (dev only)
            </button>
          </form>
        ) : null}
      </div>

      <div>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Policies</h2>
          {isOwner && policies.length === 0 ? (
            <form action={createDefaultPolicyAction.bind(null, orgSlug)}>
              <button type="submit" className={cn(buttonVariants({ variant: "primary", size: "sm" }))}>
                Create default policy
              </button>
            </form>
          ) : null}
        </div>

        {policies.length > 0 ? (
          <ul className="mt-3 flex flex-col divide-y divide-border rounded-md border border-border">
            {policies.map((policy) => (
              <li key={policy.id} className="flex flex-col gap-3 px-4 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{policy.name}</span>
                    {policy.isDefault ? <Badge tone="neutral">Default</Badge> : null}
                    <Badge tone={policy.enabled ? "success" : "neutral"}>{policy.enabled ? "Enabled" : "Disabled"}</Badge>
                    <Badge tone={policy.automationMode === "AUTO_SEND" ? "warning" : "neutral"}>
                      {policy.automationMode === "AUTO_SEND" ? "Auto-send" : "Approval required"}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted">version {policy.currentVersion}</p>
                </div>
                {isOwner ? (
                  <div className="flex flex-wrap gap-2">
                    {!policy.isDefault ? (
                      <form action={setDefaultPolicyAction.bind(null, orgSlug, policy.id)}>
                        <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                          Make default
                        </button>
                      </form>
                    ) : null}
                    <form action={setPolicyEnabledAction.bind(null, orgSlug, policy.id, !policy.enabled)}>
                      <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                        {policy.enabled ? "Disable" : "Enable"}
                      </button>
                    </form>
                    <form
                      action={setPolicyAutomationModeAction.bind(
                        null,
                        orgSlug,
                        policy.id,
                        policy.automationMode === "AUTO_SEND" ? "APPROVAL_REQUIRED" : "AUTO_SEND",
                      )}
                    >
                      <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                        {policy.automationMode === "AUTO_SEND" ? "Switch to approval required" : "Switch to auto-send"}
                      </button>
                    </form>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted">
            No collection policy yet. {isOwner ? "Create one to start enrolling overdue invoices." : "Ask an organization owner to create one."}
          </p>
        )}
      </div>

      <div>
        <h2 className="text-sm font-semibold">Active sequences</h2>
        {activeSequences.length > 0 ? (
          <ul className="mt-3 flex flex-col divide-y divide-border rounded-md border border-border">
            {activeSequences.map((sequence, index) => {
              const status = sequenceStatuses[index]!;
              const tone = SEQUENCE_STATUS_TONE[sequence.status === "PAUSED" ? "paused" : status.kind] ?? "neutral";
              const label =
                sequence.status === "PAUSED"
                  ? "Paused"
                  : status.kind === "blocked_uncertain"
                    ? "Blocked — delivery uncertain"
                    : status.kind === "active"
                      ? `Step ${status.stepsCompleted} of ${status.stepCount}`
                      : "Active";
              return (
                <li key={sequence.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                  <div className="flex flex-col gap-1">
                    <Link href={`/app/${orgSlug}/invoices/${sequence.invoiceId}`} className="font-medium hover:underline">
                      {sequence.invoice.number}
                    </Link>
                    <span className="text-xs text-muted">{sequence.customer.name}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge tone={tone}>{label}</Badge>
                    {isOwner ? (
                      <div className="flex gap-2">
                        {sequence.status === "ACTIVE" ? (
                          <form action={pauseSequenceAction.bind(null, orgSlug, sequence.id)}>
                            <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                              Pause
                            </button>
                          </form>
                        ) : (
                          <form action={resumeSequenceAction.bind(null, orgSlug, sequence.id)}>
                            <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                              Resume
                            </button>
                          </form>
                        )}
                        <form action={stopSequenceAction.bind(null, orgSlug, sequence.id)}>
                          <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                            Stop
                          </button>
                        </form>
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted">No active collection sequences.</p>
        )}
      </div>
    </div>
  );
}
