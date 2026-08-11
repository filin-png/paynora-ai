import Link from "next/link";
import type { Communication, DeliveryAttempt } from "@prisma/client";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getCommunicationForProposal } from "@/server/communications/draft";
import { listDeliveryAttempts } from "@/server/communications/send";
import { getActionProposal } from "@/server/operator/approval";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import {
  prepareCommunicationAction,
  resendUncertainCommunicationAction,
  sendCommunicationAction,
  updateCommunicationAction,
} from "./actions";
import { EditCommunicationForm } from "./edit-form";
import { SendCommunicationForm } from "./send-form";

const STATUS_BADGE: Record<Communication["status"], { label: string; tone: NonNullable<BadgeProps["tone"]> }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  SENDING: { label: "Delivery status uncertain", tone: "warning" },
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
  const proposal = await getActionProposal(context.organization.id, proposalId);
  const communication = await getCommunicationForProposal(context.organization.id, proposalId);
  const deliveryAttempts = communication
    ? await listDeliveryAttempts(context.organization.id, communication.id)
    : [];

  const boundPrepare = prepareCommunicationAction.bind(null, orgSlug, proposalId);

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <div>
        <Link href={`/app/${orgSlug}/actions`} className="text-xs text-muted hover:underline">
          &larr; Back to Action Center
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Payment reminder</h1>
        {proposal.invoice ? (
          <p className="mt-1 text-sm text-muted">
            <Link href={`/app/${orgSlug}/invoices/${proposal.invoice.id}`} className="hover:underline">
              Invoice {proposal.invoice.number}
            </Link>{" "}
            — {proposal.invoice.customer.name}
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted">Invoice no longer available</p>
        )}
      </div>

      {proposal.status !== "APPROVED" && proposal.status !== "EXECUTED" ? (
        <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
          This proposal isn&rsquo;t approved yet — nothing to review here.
        </p>
      ) : !communication ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">{proposal.reasoning}</p>
          <form action={boundPrepare}>
            <button type="submit" className={cn(buttonVariants({ variant: "primary" }))}>
              Prepare reminder email
            </button>
          </form>
        </div>
      ) : (
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
  const status = STATUS_BADGE[communication.status];
  const boundUpdate = updateCommunicationAction.bind(null, orgSlug, proposalId, communication.id);
  const boundSend = sendCommunicationAction.bind(null, orgSlug, proposalId, communication.id);
  const boundResendUncertain = resendUncertainCommunicationAction.bind(null, orgSlug, proposalId, communication.id);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 rounded-md border border-border p-4 text-sm sm:grid-cols-3">
        <div>
          <p className="text-xs text-muted">To</p>
          <p className="mt-1 font-medium">{communication.recipient}</p>
        </div>
        <div>
          <p className="text-xs text-muted">Status</p>
          <p className="mt-1">
            <Badge tone={status.tone}>{status.label}</Badge>
          </p>
        </div>
        {communication.sentAt ? (
          <div>
            <p className="text-xs text-muted">Sent</p>
            <p className="mt-1 font-medium">{communication.sentAt.toISOString().slice(0, 16).replace("T", " ")}</p>
          </div>
        ) : null}
      </div>

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
            <SendCommunicationForm action={boundSend} label="Send email" pendingLabel="Sending…" />
          </div>
        </>
      ) : (
        <div className="rounded-md border border-border p-4 text-sm">
          <p className="text-xs text-muted">Subject</p>
          <p className="mt-1 font-medium">{communication.subject}</p>
          <p className="mt-4 text-xs text-muted">Body</p>
          <p className="mt-1 whitespace-pre-wrap">{communication.body}</p>
        </div>
      )}

      {communication.status === "FAILED" ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-red-600">
            {deliveryAttempts.at(-1)?.failureMessage ?? "The email provider rejected this message."}
          </p>
          <SendCommunicationForm
            action={boundSend}
            label="Retry"
            pendingLabel="Retrying…"
            variant="outline"
          />
        </div>
      ) : null}

      {communication.status === "SENDING" || communication.status === "UNCERTAIN" ? (
        <div className="flex flex-col gap-2 rounded-md border border-amber-600/30 bg-amber-600/10 p-4">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">Delivery status uncertain</p>
          <p className="text-sm text-muted">
            We couldn&rsquo;t confirm whether this email was delivered. Do not resend automatically — resending
            may send a duplicate. Only resend if you&rsquo;ve verified with the recipient or your email
            provider that the original was not delivered.
          </p>
          <div className="mt-2">
            <SendCommunicationForm
              action={boundResendUncertain}
              label="Resend anyway (may send a duplicate)"
              pendingLabel="Sending…"
              variant="outline"
              confirmMessage="This may send a duplicate email if the previous attempt actually succeeded. Resend anyway?"
            />
          </div>
        </div>
      ) : null}

      {deliveryAttempts.length > 0 ? (
        <div>
          <h2 className="text-sm font-semibold">Delivery attempts</h2>
          <ul className="mt-3 flex flex-col divide-y divide-border rounded-md border border-border text-sm">
            {deliveryAttempts.map((attempt) => (
              <li key={attempt.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <span>
                  Attempt #{attempt.attemptNumber} — {attempt.provider}
                </span>
                <span className="flex items-center gap-2 text-muted">
                  {attempt.failureMessage ? <span>{attempt.failureMessage}</span> : null}
                  <Badge
                    tone={
                      attempt.status === "SUCCESS"
                        ? "success"
                        : attempt.status === "FAILED"
                          ? "danger"
                          : "warning"
                    }
                  >
                    {attempt.status}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
