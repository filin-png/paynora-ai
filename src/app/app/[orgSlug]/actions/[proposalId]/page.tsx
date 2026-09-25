import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import type { Communication, DeliveryAttempt } from "@prisma/client";

import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { getDictionary, type Dictionary } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/get-locale";
import { isResourceNotFoundError } from "@/lib/not-found";
import { resolveCommunicationDestination } from "@/server/communications/channel";
import { getCommunicationForProposal } from "@/server/communications/draft";
import { listDeliveryAttempts, STALE_SENDING_THRESHOLD_MS } from "@/server/communications/send";
import { getActionProposal } from "@/server/operator/approval";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import {
  prepareCommunicationAction,
  reconcileStaleSendingCommunicationAction,
  resendUncertainCommunicationAction,
  sendCommunicationAction,
  updateCommunicationAction,
} from "./actions";
import { EditCommunicationForm } from "./edit-form";
import { SendCommunicationForm } from "./send-form";

export default async function ActionProposalPage({
  params,
}: {
  params: Promise<{ orgSlug: string; proposalId: string }>;
}) {
  const { orgSlug, proposalId } = await params;
  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = dict.actionDetail;
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const proposal = await getActionProposal(context.organization.id, proposalId).catch((error: unknown) => {
    if (isResourceNotFoundError(error)) notFound();
    throw error;
  });
  const communication = await getCommunicationForProposal(context.organization.id, proposalId);
  const deliveryAttempts = communication
    ? await listDeliveryAttempts(context.organization.id, communication.id)
    : [];

  const boundPrepare = prepareCommunicationAction.bind(null, orgSlug, proposalId);

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <div>
        <Link
          href={`/app/${orgSlug}/actions`}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          {dict.actionCenter.title}
        </Link>
        <PageHeader
          className="mt-3"
          title={t.paymentReminderTitle}
          description={
            proposal.invoice ? (
              <>
                <Link href={`/app/${orgSlug}/invoices/${proposal.invoice.id}`} className="font-medium text-primary hover:underline">
                  {t.invoiceLabel.replace("{number}", proposal.invoice.number)}
                </Link>{" "}
                — {proposal.invoice.customer.name}
              </>
            ) : (
              dict.actionCenter.invoiceNoLongerAvailable
            )
          }
        />
      </div>

      {proposal.status !== "APPROVED" && proposal.status !== "EXECUTED" ? (
        <Alert tone="neutral">{t.notApprovedYet}</Alert>
      ) : !communication && proposal.invoice ? (
        (() => {
          const destination = resolveCommunicationDestination(proposal.invoice.customer);
          if (destination.blocked) {
            return (
              <Alert tone="warning" title={t.noChannelConfigured}>
                <p>{destination.reason}</p>
                <Link
                  href={`/app/${orgSlug}/customers/${proposal.invoice!.customer.id}/edit`}
                  className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
                >
                  {t.editCustomer}
                </Link>
              </Alert>
            );
          }
          return (
            <Card className="flex flex-col gap-4 p-6">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{t.channelField}</span>
                <Badge tone="info">{destination.channel === "EMAIL" ? t.channelEmail : t.channelTelegram}</Badge>
                <span className="font-medium text-foreground">{destination.destination}</span>
              </div>
              <p className="text-sm text-muted">{proposal.reasoning}</p>
              <form action={boundPrepare}>
                <Button type="submit">{t.prepareReminder}</Button>
              </form>
            </Card>
          );
        })()
      ) : !communication ? null : (
        <CommunicationReview
          orgSlug={orgSlug}
          proposalId={proposalId}
          communication={communication}
          deliveryAttempts={deliveryAttempts}
          dict={dict}
        />
      )}
    </div>
  );
}

// A SENDING communication is stale (safe to reconcile) once its most
// recent PENDING delivery attempt has sat unresolved for longer than any
// real provider timeout could explain — see
// src/server/communications/send.ts#reconcileStaleSendingCommunication and
// docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-3. A fresh SENDING might
// still be genuinely in flight, so no recovery action is offered for it —
// the backend would refuse it anyway, and this UI must never promise an
// action the backend doesn't allow. A plain (non-component) function so
// the one impure `Date.now()` read lives outside any component render —
// see docs/product-ui.md for why this codebase always threads "now" in
// explicitly rather than reading the clock inside a component.
function isSendingStale(communication: Communication, deliveryAttempts: DeliveryAttempt[]): boolean {
  if (communication.status !== "SENDING") return false;
  const pendingAttempt = deliveryAttempts.find((attempt) => attempt.status === "PENDING");
  if (!pendingAttempt) return false;
  return Date.now() - pendingAttempt.startedAt.getTime() > STALE_SENDING_THRESHOLD_MS;
}

function CommunicationReview({
  orgSlug,
  proposalId,
  communication,
  deliveryAttempts,
  dict,
}: {
  orgSlug: string;
  proposalId: string;
  communication: Communication;
  deliveryAttempts: DeliveryAttempt[];
  dict: Dictionary;
}) {
  const t = dict.actionDetail;
  const STATUS_BADGE: Record<Communication["status"], { label: string; tone: NonNullable<BadgeProps["tone"]> }> = {
    DRAFT: { label: t.statusDraft, tone: "neutral" },
    SENDING: { label: t.statusSending, tone: "warning" },
    SENT: { label: t.statusSent, tone: "success" },
    FAILED: { label: t.statusFailed, tone: "danger" },
    UNCERTAIN: { label: t.statusUncertain, tone: "warning" },
  };
  const ATTEMPT_STATUS_LABEL: Record<DeliveryAttempt["status"], string> = {
    PENDING: t.attemptStatusPending,
    SUCCESS: t.attemptStatusSuccess,
    FAILED: t.attemptStatusFailed,
    UNKNOWN: t.attemptStatusUnknown,
  };
  const boundUpdate = updateCommunicationAction.bind(null, orgSlug, proposalId, communication.id);
  const boundSend = sendCommunicationAction.bind(null, orgSlug, proposalId, communication.id);
  const boundResendUncertain = resendUncertainCommunicationAction.bind(null, orgSlug, proposalId, communication.id);
  const boundReconcile = reconcileStaleSendingCommunicationAction.bind(null, orgSlug, proposalId, communication.id);
  const sendingIsStale = isSendingStale(communication, deliveryAttempts);
  const channelLabel = communication.channel === "EMAIL" ? t.channelEmailLower : t.channelTelegramMessage;

  const status =
    communication.status === "SENDING" && sendingIsStale
      ? { label: t.statusUnknown, tone: "warning" as const }
      : STATUS_BADGE[communication.status];

  return (
    <div className="flex flex-col gap-6">
      <Card className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-3">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t.toField}</p>
          <p className="mt-1 font-medium text-foreground">{communication.recipient}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t.statusField}</p>
          <p className="mt-1">
            <Badge tone={status.tone}>{status.label}</Badge>
          </p>
        </div>
        {communication.sentAt ? (
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t.sentField}</p>
            <p className="mt-1 font-medium text-foreground">{communication.sentAt.toISOString().slice(0, 16).replace("T", " ")}</p>
          </div>
        ) : null}
      </Card>

      {communication.status === "DRAFT" ? (
        <>
          <EditCommunicationForm
            action={boundUpdate}
            defaultSubject={communication.subject}
            defaultBody={communication.body}
            dict={dict}
          />
          <div>
            <p className="mb-2 text-xs text-muted">{t.sendingCallsProvider}</p>
            <SendCommunicationForm
              action={boundSend}
              label={t.sendEmail}
              pendingLabel={t.sendingEllipsis}
              confirmTitle={t.sendThisReminder}
              confirmMessage={t.sendConfirmMessage.replace("{channel}", channelLabel).replace("{recipient}", communication.recipient)}
              confirmLabel={t.send}
              confirmVariant="primary"
            />
          </div>
        </>
      ) : (
        <Card className="p-5">
          <p className="text-xs font-medium text-muted-foreground">{t.subjectLabel}</p>
          <p className="mt-1 font-medium text-foreground">{communication.subject}</p>
          <p className="mt-4 text-xs font-medium text-muted-foreground">{t.bodyLabel}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{communication.body}</p>
        </Card>
      )}

      {communication.status === "FAILED" ? (
        <div className="flex flex-col gap-3">
          <Alert tone="danger">{deliveryAttempts.at(-1)?.failureMessage ?? t.providerRejected}</Alert>
          <SendCommunicationForm action={boundSend} label={t.retry} pendingLabel={t.retryingEllipsis} variant="outline" />
        </div>
      ) : null}

      {communication.status === "SENDING" && !sendingIsStale ? (
        <Alert tone="warning" title={t.sendInProgressTitle}>
          <p>{t.sendInProgressBody}</p>
        </Alert>
      ) : null}

      {communication.status === "SENDING" && sendingIsStale ? (
        <Alert tone="warning" title={t.deliveryUnknownTitle}>
          <p>{t.deliveryUnknownBody.replace("{minutes}", String(Math.round(STALE_SENDING_THRESHOLD_MS / 60000)))}</p>
          <div className="mt-3">
            <SendCommunicationForm
              action={boundReconcile}
              label={t.markUncertain}
              pendingLabel={t.updatingEllipsis}
              variant="outline"
            />
          </div>
        </Alert>
      ) : null}

      {communication.status === "UNCERTAIN" ? (
        <Alert tone="warning" title={t.uncertainTitle}>
          <p>{t.uncertainBody}</p>
          <div className="mt-3">
            <SendCommunicationForm
              action={boundResendUncertain}
              label={t.resendAnyway}
              pendingLabel={t.sendingEllipsis}
              variant="outline"
              confirmTitle={t.resendThisEmail}
              confirmMessage={t.resendConfirmMessage}
              confirmLabel={t.resend}
            />
          </div>
        </Alert>
      ) : null}

      {deliveryAttempts.length > 0 ? (
        <div>
          <SectionHeader title={t.deliveryAttempts} />
          <Card className="mt-3 overflow-hidden">
            <ul className="divide-y divide-border text-sm">
              {deliveryAttempts.map((attempt) => (
                <li key={attempt.id} className="flex items-center justify-between gap-4 px-5 py-3">
                  <span className="text-foreground">
                    {t.attemptLabel.replace("{n}", String(attempt.attemptNumber)).replace("{provider}", attempt.provider)}
                  </span>
                  <span className="flex items-center gap-2 text-muted">
                    {attempt.failureMessage ? <span className="text-xs">{attempt.failureMessage}</span> : null}
                    <Badge
                      tone={
                        attempt.status === "SUCCESS"
                          ? "success"
                          : attempt.status === "FAILED"
                            ? "danger"
                            : "warning"
                      }
                    >
                      {ATTEMPT_STATUS_LABEL[attempt.status]}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
