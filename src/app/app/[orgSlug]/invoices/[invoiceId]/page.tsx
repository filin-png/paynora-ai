import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarClock, PauseCircle, PlayCircle } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogCancelButton } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { isResourceNotFoundError } from "@/lib/not-found";
import { listInvoiceActivity } from "@/server/ar/activity";
import type { Currency } from "@/server/ar/currency";
import { daysBetween, getBusinessToday, toDateOnlyString } from "@/server/ar/dates";
import { getInvoiceWithFinancials } from "@/server/ar/invoices";
import { formatMoney } from "@/server/ar/money";
import { listPaymentsForInvoice } from "@/server/ar/payments";
import { getCollectionStatusForInvoice, type CollectionStatusView } from "@/server/collections/sequences";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { listCryptoPaymentRequestsForInvoice } from "@/server/wallet/payment-requests";
import { isWalletEnabled } from "@/server/wallet/service";
import { listWallets } from "@/server/wallet/wallets";
import { getCollectionsBadgeView } from "../../collections-badge";
import { getInvoiceStatusDisplay } from "../status";
import {
  cancelInvoiceAction,
  pauseInvoiceCollectionsAction,
  recordPaymentAction,
  resumeInvoiceCollectionsAction,
} from "./actions";
import { RecordPaymentForm } from "./payment-form";

// See docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-6 — bounds a
// long-lived invoice's activity timeline.
const ACTIVITY_PAGE_SIZE = 25;

export default async function InvoiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; invoiceId: string }>;
  searchParams: Promise<{ activityCursor?: string }>;
}) {
  const { orgSlug, invoiceId } = await params;
  const { activityCursor } = await searchParams;
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const { invoice, financials } = await getInvoiceWithFinancials(context.organization.id, invoiceId).catch(
    (error: unknown) => {
      if (isResourceNotFoundError(error)) notFound();
      throw error;
    },
  );
  const canRecordPayment = invoice.status === "OPEN" && financials.outstandingMinor > 0n;

  const [payments, activityPage, collectionsStatus, cryptoRequests, activeWallets] = await Promise.all([
    listPaymentsForInvoice(context.organization.id, invoiceId),
    listInvoiceActivity(context.organization.id, invoiceId, {
      cursor: activityCursor,
      take: ACTIVITY_PAGE_SIZE + 1,
    }),
    getCollectionStatusForInvoice(context.organization.id, invoiceId),
    canRecordPayment ? listCryptoPaymentRequestsForInvoice(context.organization.id, invoiceId) : Promise.resolve([]),
    canRecordPayment ? listWallets(context.organization.id, { status: "ACTIVE" }) : Promise.resolve([]),
  ]);
  const activityHasMore = activityPage.length > ACTIVITY_PAGE_SIZE;
  const activity = activityHasMore ? activityPage.slice(0, ACTIVITY_PAGE_SIZE) : activityPage;
  const nextActivityCursor = activityHasMore ? activity.at(-1)!.id : null;

  const currency = invoice.currency as Currency;
  const status = getInvoiceStatusDisplay(invoice, financials);
  const canCancel = invoice.status === "OPEN" && financials.paidMinor === 0n;
  const overdueDays = financials.isOverdue ? daysBetween(toDateOnlyString(invoice.dueDate), getBusinessToday()) : 0;
  const cryptoAvailable = isWalletEnabled() && activeWallets.length > 0;

  const boundRecordPayment = recordPaymentAction.bind(null, orgSlug, invoiceId);
  const boundCancel = cancelInvoiceAction.bind(null, orgSlug, invoiceId);

  return (
    <div className="flex flex-col gap-10">
      <div>
        <Link
          href={`/app/${orgSlug}/invoices`}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Invoices
        </Link>

        <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">{invoice.number}</h1>
              <Badge tone={status.tone}>{status.label}</Badge>
              {financials.isOverdue ? (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
                  <CalendarClock className="size-3.5" />
                  Overdue {overdueDays} day{overdueDays === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
            <p className="text-sm text-muted">
              <Link href={`/app/${orgSlug}/customers/${invoice.customerId}`} className="hover:text-primary hover:underline">
                {invoice.customer.name}
              </Link>
            </p>
          </div>

          <div className="flex items-center gap-3">
            <p className="text-3xl font-semibold tabular-nums tracking-tight text-foreground">
              {formatMoney(financials.outstandingMinor, currency)}
            </p>
          </div>
        </div>
      </div>

      {canCancel ? (
        <div className="flex justify-end">
          <Dialog
            trigger={<Button type="button" variant="outline">Cancel invoice</Button>}
            title="Cancel this invoice?"
            description={`${invoice.number} for ${invoice.customer.name} will be marked cancelled. This cannot be undone.`}
          >
            <div className="flex justify-end gap-2">
              <DialogCancelButton className={cn(buttonVariants({ variant: "outline", size: "sm" }))} />
              <form action={boundCancel}>
                <button type="submit" className={cn(buttonVariants({ variant: "destructive", size: "sm" }))}>
                  Cancel invoice
                </button>
              </form>
            </div>
          </Dialog>
        </div>
      ) : null}

      <Card className="grid grid-cols-2 gap-6 p-6 sm:grid-cols-4">
        <Stat label="Original amount" value={formatMoney(financials.amountMinor, currency)} />
        <Stat label="Paid" value={formatMoney(financials.paidMinor, currency)} tone="success" />
        <Stat label="Outstanding" value={formatMoney(financials.outstandingMinor, currency)} />
        <Stat label="Due date" value={invoice.dueDate.toISOString().slice(0, 10)} />
      </Card>

      {invoice.notes ? (
        <Card className="p-5">
          <p className="text-xs font-medium text-muted-foreground">Notes</p>
          <p className="mt-1.5 whitespace-pre-wrap text-sm text-foreground">{invoice.notes}</p>
        </Card>
      ) : null}

      <CollectionsStatusBlock
        orgSlug={orgSlug}
        invoiceId={invoiceId}
        status={collectionsStatus}
        isOwner={context.role === "OWNER"}
      />

      {canRecordPayment ? (
        <div className="flex flex-col gap-6">
          <SectionHeader title="Payment methods" />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Bank / card</p>
              <Card className="mt-2 p-5">
                <RecordPaymentForm action={boundRecordPayment} today={getBusinessToday()} />
              </Card>
            </div>
            <div>
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Crypto</p>
              <Card className="mt-2 p-5">
                {cryptoAvailable ? (
                  cryptoRequests.length > 0 ? (
                    <ul className="flex flex-col gap-2.5 text-sm">
                      {cryptoRequests.map((request) => (
                        <li key={request.id} className="flex items-center justify-between gap-3">
                          <span className="text-foreground">
                            {request.asset} on {request.network}
                          </span>
                          <Badge tone={request.status === "OPEN" ? "info" : request.status === "FULFILLED" ? "success" : "neutral"}>
                            {request.status}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted">
                      No crypto payment request has been created for this invoice yet. Create one from{" "}
                      <Link href={`/app/${orgSlug}/wallet`} className="font-medium text-primary hover:underline">
                        Wallet
                      </Link>
                      .
                    </p>
                  )
                ) : (
                  <p className="text-sm text-muted">
                    Crypto payments aren&rsquo;t available yet — no wallet provider is connected in this deployment.
                    See{" "}
                    <Link href={`/app/${orgSlug}/wallet`} className="font-medium text-primary hover:underline">
                      Wallet
                    </Link>{" "}
                    for details.
                  </p>
                )}
              </Card>
            </div>
          </div>
        </div>
      ) : null}

      <div>
        <SectionHeader title="Payment history" />
        {payments.length > 0 ? (
          <Card className="mt-3 overflow-hidden">
            <ul className="divide-y divide-border">
              {payments.map((payment) => (
                <li key={payment.id} className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm">
                  <div className="flex flex-col">
                    <span className="text-foreground">{payment.paidAt.toISOString().slice(0, 10)}</span>
                    {payment.note ? <span className="text-xs text-muted">{payment.note}</span> : null}
                  </div>
                  <span className="font-medium tabular-nums text-success">
                    +{formatMoney(payment.amountMinor, currency)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <EmptyState className="mt-3 py-10" title="No payments recorded yet" />
        )}
      </div>

      <div>
        <SectionHeader title="Activity" />
        {activity.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-2.5 text-sm">
            {activity.map((event) => (
              <li key={event.id} className="flex items-baseline justify-between gap-4">
                <span className="text-foreground">{event.summary}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {event.createdAt.toISOString().slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted">No activity yet.</p>
        )}
        {activityHasMore ? (
          <Link
            href={`/app/${orgSlug}/invoices/${invoiceId}?activityCursor=${nextActivityCursor}`}
            className="mt-3 inline-block text-xs font-medium text-primary hover:underline"
          >
            Older activity
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "success" }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums", tone === "success" ? "text-success" : "text-foreground")}>
        {value}
      </p>
    </div>
  );
}

/**
 * Honest, per-state collections display — never claims collections are
 * "in progress" for a paid invoice, and explicitly says when a previous
 * email's delivery status is unresolved rather than silently doing
 * nothing. Labels come from the shared collections-badge mapping so the
 * word "Active"/"Paused"/"Blocked" here always matches the Automation
 * page and the invoice list. See docs/collections-automation.md#ui.
 */
function CollectionsStatusBlock({
  orgSlug,
  invoiceId,
  status,
  isOwner,
}: {
  orgSlug: string;
  invoiceId: string;
  status: CollectionStatusView;
  isOwner: boolean;
}) {
  if (status.kind === "not_enrolled") return null;
  const badge = getCollectionsBadgeView(status);

  if (status.kind === "completed") {
    return (
      <Alert tone="success" title="Collections completed">
        This invoice was paid — no further follow-up is scheduled.
      </Alert>
    );
  }

  if (status.kind === "stopped") {
    return (
      <Alert tone="neutral" title="Collections stopped">
        {status.stopReason ? `Reason: ${formatStopReason(status.stopReason)}.` : "No further follow-up is scheduled."}
      </Alert>
    );
  }

  if (status.kind === "blocked_uncertain") {
    return (
      <Alert tone="warning" title="Automation paused — delivery status uncertain">
        <p>A previous reminder&rsquo;s delivery status couldn&rsquo;t be confirmed. Manual review is required before another reminder can be scheduled automatically.</p>
        {isOwner ? (
          <form action={pauseInvoiceCollectionsAction.bind(null, orgSlug, invoiceId, status.sequenceId)} className="mt-3">
            <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              <PauseCircle className="size-4" />
              Pause collections
            </button>
          </form>
        ) : null}
      </Alert>
    );
  }

  if (status.kind === "paused") {
    return (
      <Card className="flex items-center justify-between gap-4 p-5">
        <div className="flex items-center gap-2.5">
          {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
          <span className="text-sm text-muted">Collections follow-up is paused for this invoice.</span>
        </div>
        {isOwner ? (
          <form action={resumeInvoiceCollectionsAction.bind(null, orgSlug, invoiceId, status.sequenceId)}>
            <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              <PlayCircle className="size-4" />
              Resume
            </button>
          </form>
        ) : null}
      </Card>
    );
  }

  return (
    <Card className="flex items-center justify-between gap-4 p-5">
      <div className="flex items-center gap-2.5">
        {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
        <div className="text-sm">
          <span className="font-medium text-foreground">Collections in progress</span>{" "}
          <span className="text-muted">
            — step {status.stepsCompleted} of {status.stepCount}
            {status.nextStepDaysAfterDue !== undefined
              ? `, next reminder at day +${status.nextStepDaysAfterDue} overdue`
              : ", all configured steps have run"}
          </span>
        </div>
      </div>
      {isOwner ? (
        <form action={pauseInvoiceCollectionsAction.bind(null, orgSlug, invoiceId, status.sequenceId)}>
          <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            <PauseCircle className="size-4" />
            Pause
          </button>
        </form>
      ) : null}
    </Card>
  );
}

function formatStopReason(reason: string): string {
  return reason.toLowerCase().replaceAll("_", " ");
}
