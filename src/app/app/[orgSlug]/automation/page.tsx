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
import { getDictionary } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/get-locale";
import { pluralForm } from "@/lib/i18n/plural";
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

export default async function AutomationPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = dict.automation;
  const STEP_ACTION_LABEL: Record<string, string> = {
    SEND_PAYMENT_REMINDER: dict.actionCenter.actionSendPaymentReminder,
    NOTIFY_OWNER: t.actionNotifyOwner,
  };
  const STEP_TONE_LABEL: Record<string, string> = {
    SOFT: t.toneFriendly,
    STANDARD: dict.actionCenter.toneStandard,
    FIRM: dict.actionCenter.toneFirm,
  };
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
      <PageHeader title={t.title} description={t.description} />

      <Card className="p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <p className="text-sm font-medium text-foreground">{t.collectionsAutomation}</p>
              <Badge tone={organization.automationEnabled ? "success" : "neutral"}>
                {organization.automationEnabled ? t.enabled : t.disabled}
              </Badge>
            </div>
            <p className="mt-1 max-w-lg text-xs text-muted">{t.masterSwitchDescription}</p>
          </div>
          {isOwner ? (
            organization.automationEnabled ? (
              // Disabling is the safe/kill-switch direction — no confirmation needed to stop something.
              <form action={setAutomationEnabledAction.bind(null, orgSlug, false)}>
                <button
                  type="submit"
                  aria-pressed={true}
                  aria-label={t.disableAriaLabel}
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
                    aria-label={t.enableAriaLabel}
                    className="flex items-center gap-2"
                  >
                    <Switch checked={false} />
                  </button>
                }
                action={setAutomationEnabledAction.bind(null, orgSlug, true)}
                confirmTitle={t.enableConfirmTitle}
                confirmDescription={t.enableConfirmDescription}
                confirmLabel={t.enableAutomation}
              />
            ) : (
              <Link
                href={`/app/${orgSlug}/settings?tab=billing`}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              >
                {t.notAvailableOnPlan}
              </Link>
            )
          ) : null}
        </div>

        {organization.automationEnabled && !automationEntitled ? (
          <Alert tone="warning" className="mt-4">
            {t.planNoLongerIncludes}
          </Alert>
        ) : null}

        <div className="mt-6 grid grid-cols-3 gap-6 border-t border-border pt-6">
          <Stat label={t.statActiveSequences} value={activeSequences.length} />
          <Stat label={t.statUpcomingReminders} value={upcomingCount} />
          <Stat label={t.statBlocked} value={blockedCount} tone={blockedCount > 0 ? "warning" : undefined} />
        </div>

        {isDev && isOwner ? (
          <div className="mt-6 rounded-lg border border-dashed border-border-strong p-4">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <FlaskConical className="size-3.5" />
              {t.devToolLabel}
            </div>
            <p className="mt-1.5 text-xs text-muted">{t.devToolDescription}</p>
            <form action={runManualAutomationTickAction.bind(null, orgSlug)} className="mt-3">
              <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                {t.runTickNow}
              </button>
            </form>
          </div>
        ) : null}
      </Card>

      <div className="flex flex-col gap-4">
        <SectionHeader
          title={t.policiesTitle}
          description={t.policiesDescription}
          actions={
            isOwner && policies.length === 0 ? (
              <form action={createDefaultPolicyAction.bind(null, orgSlug)}>
                <button type="submit" className={cn(buttonVariants({ size: "sm" }))}>
                  {t.createDefaultPolicy}
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
                        {policy.isDefault ? <Badge tone="info">{t.defaultBadge}</Badge> : null}
                        <Badge tone={policy.enabled ? "success" : "neutral"}>{policy.enabled ? t.enabled : t.disabled}</Badge>
                        <Badge tone={isAutoSend ? "warning" : "neutral"}>
                          {isAutoSend ? t.autoSend : t.approvalRequired}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {pluralForm(steps.length, locale, {
                          one: t.versionStepsOne,
                          few: t.versionStepsFew,
                          many: t.versionStepsMany,
                        })
                          .replace("{version}", String(policy.currentVersion))
                          .replace("{n}", String(steps.length))}
                      </p>
                    </div>
                    {isOwner ? (
                      <div className="flex flex-wrap gap-2">
                        {!policy.isDefault ? (
                          <form action={setDefaultPolicyAction.bind(null, orgSlug, policy.id)}>
                            <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                              {t.makeDefault}
                            </button>
                          </form>
                        ) : null}
                        <form action={setPolicyEnabledAction.bind(null, orgSlug, policy.id, !policy.enabled)}>
                          <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                            {policy.enabled ? t.disable : t.enable}
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
                            {t.daysOverdueAbbrev.replace("{n}", String(step.daysAfterDue))}
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
                            {t.autoSendOnWarning}
                          </Alert>
                          {/* Switching back to approval-required reduces risk — the safe direction needs no confirmation. */}
                          <form action={setPolicyAutomationModeAction.bind(null, orgSlug, policy.id, "APPROVAL_REQUIRED")}>
                            <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                              {t.switchToApprovalRequired}
                            </button>
                          </form>
                        </>
                      ) : (
                        <ConfirmActionButton
                          trigger={
                            <button type="button" className={cn(buttonVariants({ variant: "destructive", size: "sm" }))}>
                              <AlertTriangle className="size-4" />
                              {t.switchToAutoSend}
                            </button>
                          }
                          action={setPolicyAutomationModeAction.bind(null, orgSlug, policy.id, "AUTO_SEND")}
                          confirmTitle={t.turnOnAutoSendTitle}
                          confirmDescription={t.turnOnAutoSendDescription.replace("{policy}", policy.name)}
                          confirmLabel={t.turnOnAutoSend}
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
            title={t.noPolicyTitle}
            description={isOwner ? t.noPolicyOwnerDescription : t.noPolicyMemberDescription}
          />
        )}
      </div>

      <div>
        <SectionHeader title={t.activeSequencesTitle} />
        {activeSequences.length > 0 ? (
          <Card className="mt-3 overflow-hidden">
            <ul className="divide-y divide-border">
              {activeSequences.map((sequence, index) => {
                const status = sequenceStatuses[index]!;
                const tone = SEQUENCE_STATUS_TONE[sequence.status === "PAUSED" ? "paused" : status.kind] ?? "neutral";
                const label =
                  sequence.status === "PAUSED"
                    ? t.pausedLabel
                    : status.kind === "blocked_uncertain"
                      ? t.blockedUncertainLabel
                      : status.kind === "active"
                        ? t.stepOfLabel
                            .replace("{completed}", String(status.stepsCompleted))
                            .replace("{total}", String(status.stepCount))
                        : t.activeLabel;
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
                              <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))} aria-label={t.pauseSequenceAria}>
                                <PauseCircle className="size-4" />
                              </button>
                            </form>
                          ) : (
                            <form action={resumeSequenceAction.bind(null, orgSlug, sequence.id)}>
                              <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))} aria-label={t.resumeSequenceAria}>
                                <PlayCircle className="size-4" />
                              </button>
                            </form>
                          )}
                          <form action={stopSequenceAction.bind(null, orgSlug, sequence.id)}>
                            <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))} aria-label={t.stopSequenceAria}>
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
          <EmptyState className="mt-3 py-10" title={t.noActiveSequences} />
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
