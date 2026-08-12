import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import type { Communication, DeliveryAttempt } from "@prisma/client";

import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
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

const STATUS_BADGE: Record<Communication["status"], { label: string; tone: NonNullable<BadgeProps["tone"]> }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  // SENDING has two distinct sub-states in practice (fresh vs. stale) —
  // CommunicationReview below overrides this default for a SENDING row,
  // this entry is only the fallback shape.
  SENDING: { label: "Sending…", tone: "warning" },
  SENT: { label: "Sent", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  UNCERTAIN: { label: "Delivery status uncertain", tone: "warning" },
};

export default async function ActionProposalPage({
  params,
}: {
  params: Promise<{ orgSlug: string; proposalId: string }>;
}) {
  const { orgSlug, proposalId } = await params;
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
          Action Center
        </Link>
        <PageHeader
          className="mt-3"
          title="Payment reminder"
          description={
            proposal.invoice ? (
              <>
                <Link href={`/app/${orgSlug}/invoices/${proposal.invoice.id}`} className="font-medium text-primary hover:underline">
                  Invoice {proposal.invoice.number}
                </Link>{" "}
                — {proposal.invoice.customer.name}
              </>
            ) : (
              "Invoice no longer available"
            )
          }
        />
      </div>

      {proposal.status !== "APPROVED" && proposal.status !== "EXECUTED" ? (
        <Alert tone="neutral">This proposal isn&rsquo;t approved yet — nothing to review here.</Alert>
      ) : !communication && proposal.invoice ? (
        (() => {
          const destination = resolveCommunicationDestination(proposal.invoice.customer);
          if (destination.blocked) {
            return (
              <Alert tone="warning" title="No communication channel configured">
                <p>{destination.reason}</p>
                <Link
                  href={`/app/${orgSlug}/customers/${proposal.invoice!.customer.id}/edit`}
                  className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
                >
                  Edit customer
                </Link>
              </Alert>
            );
          }
          return (
            <Card className="flex flex-col gap-4 p-6">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Channel:</span>
                <Badge tone="info">{destination.channel === "EMAIL" ? "Email" : "Telegram"}</Badge>
                <span className="font-medium text-foreground">{destination.destination}</span>
              </div>
              <p className="text-sm text-muted">{proposal.reasoning}</p>
              <form action={boundPrepare}>
                <Button type="submit">Prepare reminder</Button>
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
}: {
  orgSlug: string;
  proposalId: string;
  communication: Communication;
  deliveryAttempts: DeliveryAttempt[];
}) {
  const boundUpdate = updateCommunicationAction.bind(null, orgSlug, proposalId, communication.id);
  const boundSend = sendCommunicationAction.bind(null, orgSlug, proposalId, communication.id);
  const boundResendUncertain = resendUncertainCommunicationAction.bind(null, orgSlug, proposalId, communication.id);
  const boundReconcile = reconcileStaleSendingCommunicationAction.bind(null, orgSlug, proposalId, communication.id);
  const sendingIsStale = isSendingStale(communication, deliveryAttempts);
  const channelLabel = communication.channel === "EMAIL" ? "email" : "Telegram message";

  const status =
    communication.status === "SENDING" && sendingIsStale
      ? { label: "Delivery status unknown", tone: "warning" as const }
      : STATUS_BADGE[communication.status];

  return (
    <div className="flex flex-col gap-6">
      <Card className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-3">
        <div>
          <p className="text-xs font-medium text-muted-foreground">To</p>
          <p className="mt-1 font-medium text-foreground">{communication.recipient}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Status</p>
          <p className="mt-1">
            <Badge tone={status.tone}>{status.label}</Badge>
          </p>
        </div>
        {communication.sentAt ? (
          <div>
            <p className="text-xs font-medium text-muted-foreground">Sent</p>
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
          />
          <div>
            <p className="mb-2 text-xs text-muted">
              Sending calls your configured email provider for real. Review the message above before sending.
            </p>
            <SendCommunicationForm
              action={boundSend}
              label="Send email"
              pendingLabel="Sending…"
              confirmTitle="Send this reminder?"
              confirmMessage={`This will send a real ${channelLabel} to ${communication.recipient}. This cannot be undone.`}
              confirmLabel="Send"
              confirmVariant="primary"
            />
          </div>
        </>
      ) : (
        <Card className="p-5">
          <p className="text-xs font-medium text-muted-foreground">Subject</p>
          <p className="mt-1 font-medium text-foreground">{communication.subject}</p>
          <p className="mt-4 text-xs font-medium text-muted-foreground">Body</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{communication.body}</p>
        </Card>
      )}

      {communication.status === "FAILED" ? (
        <div className="flex flex-col gap-3">
          <Alert tone="danger">{deliveryAttempts.at(-1)?.failureMessage ?? "The email provider rejected this message."}</Alert>
          <SendCommunicationForm action={boundSend} label="Retry" pendingLabel="Retrying…" variant="outline" />
        </div>
      ) : null}

      {communication.status === "SENDING" && !sendingIsStale ? (
        <Alert tone="warning" title="Send in progress">
          <p>
            A send attempt for this message is still in progress or has not yet reported an outcome. This usually
            resolves within a few seconds. If this message is still here after a while, it likely means the send
            process was interrupted — check back shortly for a recovery option.
          </p>
        </Alert>
      ) : null}

      {communication.status === "SENDING" && sendingIsStale ? (
        <Alert tone="warning" title="Delivery status unknown — send never reported an outcome">
          <p>
            A send attempt for this message started more than {Math.round(STALE_SENDING_THRESHOLD_MS / 60000)} minutes
            ago and never reported success or failure — most likely the process was interrupted mid-send. We cannot
            tell whether the message was actually delivered.
          </p>
          <div className="mt-3">
            <SendCommunicationForm
              action={boundReconcile}
              label="Mark as uncertain (review before resending)"
              pendingLabel="Updating…"
              variant="outline"
            />
          </div>
        </Alert>
      ) : null}

      {communication.status === "UNCERTAIN" ? (
        <Alert tone="warning" title="Delivery status uncertain">
          <p>
            We couldn&rsquo;t confirm whether this email was delivered. Do not resend automatically — resending may
            send a duplicate. Only resend if you&rsquo;ve verified with the recipient or your email provider that the
            original was not delivered.
          </p>
          <div className="mt-3">
            <SendCommunicationForm
              action={boundResendUncertain}
              label="Resend anyway (may send a duplicate)"
              pendingLabel="Sending…"
              variant="outline"
              confirmTitle="Resend this email?"
              confirmMessage="This may send a duplicate email if the previous attempt actually succeeded. Resend anyway?"
              confirmLabel="Resend"
            />
          </div>
        </Alert>
      ) : null}

      {deliveryAttempts.length > 0 ? (
        <div>
          <SectionHeader title="Delivery attempts" />
          <Card className="mt-3 overflow-hidden">
            <ul className="divide-y divide-border text-sm">
              {deliveryAttempts.map((attempt) => (
                <li key={attempt.id} className="flex items-center justify-between gap-4 px-5 py-3">
                  <span className="text-foreground">
                    Attempt #{attempt.attemptNumber} — {attempt.provider}
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
                      {attempt.status.charAt(0) + attempt.status.slice(1).toLowerCase()}
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
