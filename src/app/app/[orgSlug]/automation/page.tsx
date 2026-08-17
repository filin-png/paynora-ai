import Link from "next/link";
import { AlertTriangle, FlaskConical, PauseCircle, PlayCircle, Square, Zap } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmActionButton } from "@/components/ui/confirm-action-button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { getOrganizationEntitlements } from "@/server/billing/entitlements";
import { getCollectionPolicySteps, listCollectionPolicies } from "@/server/collections/policy";
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

const STEP_ACTION_LABEL: Record<string, string> = {
  SEND_PAYMENT_REMINDER: "Send a payment reminder",
  NOTIFY_OWNER: "Notify the owner",
};

const STEP_TONE_LABEL: Record<string, string> = {
  SOFT: "friendly",
  STANDARD: "standard",
  FIRM: "firm",
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

  const [organization, policies, activeSequences, { entitlements }] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
    listCollectionPolicies(organizationId),
    listActiveCollectionSequences(organizationId),
    getOrganizationEntitlements(organizationId),
  ]);
  const automationEntitled = entitlements.collectionsAutomationEnabled;

  const [sequenceStatuses, policyStepsByPolicy] = await Promise.all([
    Promise.all(activeSequences.map((sequence) => getCollectionStatusForInvoice(organizationId, sequence.invoiceId))),
    Promise.all(policies.map((policy) => getCollectionPolicySteps(policy.id, policy.currentVersion))),
  ]);

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
      <PageHeader title="Automation" description="Define how PAYNORA follows up on overdue invoices." />

      <Card className="p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <p className="text-sm font-medium text-foreground">Collections automation</p>
              <Badge tone={organization.automationEnabled ? "success" : "neutral"}>
                {organization.automationEnabled ? "Enabled" : "Disabled"}
              </Badge>
            </div>
            <p className="mt-1 max-w-lg text-xs text-muted">
              The master switch. When disabled, nothing runs for this organization on a schedule — the AR
              dashboard, Action Center, and manual sends are unaffected either way.
            </p>
          </div>
          {isOwner ? (
            organization.automationEnabled ? (
              // Disabling is the safe/kill-switch direction — no confirmation needed to stop something.
              <form action={setAutomationEnabledAction.bind(null, orgSlug, false)}>
                <button
                  type="submit"
                  aria-pressed={true}
                  aria-label="Disable collections automation"
                  className="flex items-center gap-2"
                >
                  <Switch checked={true} />
                </button>
              </form>
            ) : automationEntitled ? (
              <ConfirmActionButton
                trigger={
                  <button
                    type="button"
                    aria-pressed={false}
                    aria-label="Enable collections automation"
                    className="flex items-center gap-2"
                  >
                    <Switch checked={false} />
                  </button>
                }
                action={setAutomationEnabledAction.bind(null, orgSlug, true)}
                confirmTitle="Enable collections automation?"
                confirmDescription="Every enabled collection policy for this organization — including any already set to auto-send — will start running on the next scheduled tick. Invoices matching a policy step may be emailed or messaged automatically."
                confirmLabel="Enable automation"
              />
            ) : (
              <Link
                href={`/app/${orgSlug}/settings?tab=billing`}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              >
                Not available on current plan
              </Link>
            )
          ) : null}
        </div>

        {organization.automationEnabled && !automationEntitled ? (
          <Alert tone="warning" className="mt-4">
            This organization&apos;s current plan no longer includes Collections Automation — no new steps will run
            until the plan changes. Policies and history are preserved.
          </Alert>
        ) : null}

        <div className="mt-6 grid grid-cols-3 gap-6 border-t border-border pt-6">
          <Stat label="Active sequences" value={activeSequences.length} />
          <Stat label="Upcoming reminders" value={upcomingCount} />
          <Stat label="Blocked (uncertain delivery)" value={blockedCount} tone={blockedCount > 0 ? "warning" : undefined} />
        </div>

        {isDev && isOwner ? (
          <div className="mt-6 rounded-lg border border-dashed border-border-strong p-4">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <FlaskConical className="size-3.5" />
              Developer tool — not part of the product
            </div>
            <p className="mt-1.5 text-xs text-muted">
              No scheduler is configured to call this automatically in this environment — see
              docs/collections-automation.md#scheduler-deployment for how a real deployment wires up the tick
              endpoint.
            </p>
            <form action={runManualAutomationTickAction.bind(null, orgSlug)} className="mt-3">
              <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                Run automation tick now
              </button>
            </form>
          </div>
        ) : null}
      </Card>

      <div className="flex flex-col gap-4">
        <SectionHeader
          title="Policies"
          description="How overdue invoices get followed up"
          actions={
            isOwner && policies.length === 0 ? (
              <form action={createDefaultPolicyAction.bind(null, orgSlug)}>
                <button type="submit" className={cn(buttonVariants({ size: "sm" }))}>
                  Create default policy
                </button>
              </form>
            ) : undefined
          }
        />

        {policies.length > 0 ? (
          <div className="flex flex-col gap-4">
            {policies.map((policy, index) => {
              const steps = policyStepsByPolicy[index]!;
              const isAutoSend = policy.automationMode === "AUTO_SEND";
              return (
                <Card key={policy.id} className="p-6">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">{policy.name}</span>
                        {policy.isDefault ? <Badge tone="info">Default</Badge> : null}
                        <Badge tone={policy.enabled ? "success" : "neutral"}>{policy.enabled ? "Enabled" : "Disabled"}</Badge>
                        <Badge tone={isAutoSend ? "warning" : "neutral"}>
                          {isAutoSend ? "Auto-send" : "Approval required"}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Version {policy.currentVersion} · {steps.length} step{steps.length === 1 ? "" : "s"}
                      </p>
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
                      </div>
                    ) : null}
                  </div>

                  {steps.length > 0 ? (
                    <ol className="relative mt-6 flex flex-col gap-5 pl-6">
                      <span aria-hidden="true" className="absolute top-1 bottom-1 left-[7px] w-px bg-border-strong" />
                      {steps.map((step) => (
                        <li key={step.id} className="relative flex items-baseline gap-4 text-sm">
                          <span aria-hidden="true" className="absolute -left-6 top-1.5 size-2.5 rounded-full border-2 border-primary bg-surface" />
                          <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">
                            +{step.daysAfterDue}d overdue
                          </span>
                          <span className="text-foreground">
                            {STEP_ACTION_LABEL[step.action] ?? step.action}{" "}
                            <span className="text-muted-foreground">({STEP_TONE_LABEL[step.tone] ?? step.tone.toLowerCase()})</span>
                          </span>
                        </li>
                      ))}
                    </ol>
                  ) : null}

                  {isOwner ? (
                    <div className="mt-6 border-t border-border pt-4">
                      {isAutoSend ? (
                        <>
                          <Alert tone="warning" className="mb-3">
                            Auto-send is on: approved reminders on this policy go out without a manual review step.
                            A fresh financial check still happens immediately before every send.
                          </Alert>
                          {/* Switching back to approval-required reduces risk — the safe direction needs no confirmation. */}
                          <form action={setPolicyAutomationModeAction.bind(null, orgSlug, policy.id, "APPROVAL_REQUIRED")}>
                            <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                              Switch to approval required
                            </button>
                          </form>
                        </>
                      ) : (
                        <ConfirmActionButton
                          trigger={
                            <button type="button" className={cn(buttonVariants({ variant: "destructive", size: "sm" }))}>
                              <AlertTriangle className="size-4" />
                              Switch to auto-send
                            </button>
                          }
                          action={setPolicyAutomationModeAction.bind(null, orgSlug, policy.id, "AUTO_SEND")}
                          confirmTitle="Turn on auto-send for this policy?"
                          confirmDescription={`Every future reminder generated under "${policy.name}" will be sent automatically as soon as it's due, with no human review step. A fresh financial check still runs immediately before each send. You can switch back to approval-required at any time.`}
                          confirmLabel="Turn on auto-send"
                        />
                      )}
                    </div>
                  ) : null}
                </Card>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={Zap}
            title="No collection policy configured"
            description={isOwner ? "Create one to start enrolling overdue invoices in a follow-up sequence." : "Ask an organization owner to create one."}
          />
        )}
      </div>

      <div>
        <SectionHeader title="Active sequences" />
        {activeSequences.length > 0 ? (
          <Card className="mt-3 overflow-hidden">
            <ul className="divide-y divide-border">
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
                  <li key={sequence.id} className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-col gap-0.5 text-sm">
                      <Link href={`/app/${orgSlug}/invoices/${sequence.invoiceId}`} className="font-medium text-foreground hover:text-primary hover:underline">
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
                              <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))} aria-label="Pause sequence">
                                <PauseCircle className="size-4" />
                              </button>
                            </form>
                          ) : (
                            <form action={resumeSequenceAction.bind(null, orgSlug, sequence.id)}>
                              <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))} aria-label="Resume sequence">
                                <PlayCircle className="size-4" />
                              </button>
                            </form>
                          )}
                          <form action={stopSequenceAction.bind(null, orgSlug, sequence.id)}>
                            <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))} aria-label="Stop sequence">
                              <Square className="size-4" />
                            </button>
                          </form>
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        ) : (
          <EmptyState className="mt-3 py-10" title="No active collection sequences" />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warning" }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums", tone === "warning" ? "text-warning" : "text-foreground")}>
        {value}
      </p>
    </div>
  );
}
