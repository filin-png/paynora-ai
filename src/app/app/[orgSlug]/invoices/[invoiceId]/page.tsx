import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarClock, PauseCircle, PlayCircle } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogCancelButton } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/page-header";
import { CopilotPanel } from "@/components/copilot/copilot-panel";
import { getDictionary, type Dictionary } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/get-locale";
import { pluralForm } from "@/lib/i18n/plural";
import { cn } from "@/lib/utils";
import { isResourceNotFoundError } from "@/lib/not-found";
import { listInvoiceActivity } from "@/server/ar/activity";
import type { Currency } from "@/server/ar/currency";
import { daysBetween, getBusinessToday, toDateOnlyString } from "@/server/ar/dates";
import { getInvoiceWithFinancials } from "@/server/ar/invoices";
import { formatMoney } from "@/server/ar/money";
import { listPaymentsForInvoice } from "@/server/ar/payments";
import { getPaymentOutlookForInvoiceIds, type PaymentOutlookBand } from "@/server/attention/payment-outlook";
import { getCollectionStatusForInvoice, type CollectionStatusView } from "@/server/collections/sequences";

const OUTLOOK_TONE: Record<PaymentOutlookBand, NonNullable<BadgeProps["tone"]>> = {
  "on-track": "neutral",
  likely: "success",
  "at-risk": "danger",
  "insufficient-history": "neutral",
};
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
  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = dict.invoiceDetail;
  const OUTLOOK_LABEL: Record<PaymentOutlookBand, string> = {
    "on-track": dict.invoices.outlookOnTrack,
    likely: dict.invoices.outlookLikely,
    "at-risk": dict.invoices.outlookAtRisk,
    "insufficient-history": dict.invoices.outlookInsufficientHistory,
  };
  const CRYPTO_STATUS_LABEL: Record<string, string> = {
    OPEN: t.cryptoStatusOpen,
    FULFILLED: t.cryptoStatusFulfilled,
    CANCELLED: t.cryptoStatusCancelled,
    EXPIRED: t.cryptoStatusExpired,
  };
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const { invoice, financials } = await getInvoiceWithFinancials(context.organization.id, invoiceId).catch(
    (error: unknown) => {
      if (isResourceNotFoundError(error)) notFound();
      throw error;
    },
  );
  const canRecordPayment = invoice.status === "OPEN" && financials.outstandingMinor > 0n;

  const [payments, activityPage, collectionsStatus, cryptoRequests, activeWallets, paymentOutlooks] = await Promise.all([
    listPaymentsForInvoice(context.organization.id, invoiceId),
    listInvoiceActivity(context.organization.id, invoiceId, {
      cursor: activityCursor,
      take: ACTIVITY_PAGE_SIZE + 1,
    }),
    getCollectionStatusForInvoice(context.organization.id, invoiceId),
    canRecordPayment ? listCryptoPaymentRequestsForInvoice(context.organization.id, invoiceId) : Promise.resolve([]),
    canRecordPayment ? listWallets(context.organization.id, { status: "ACTIVE" }) : Promise.resolve([]),
    getPaymentOutlookForInvoiceIds(context.organization.id, [invoiceId], getBusinessToday()),
  ]);
  const outlook = paymentOutlooks.get(invoiceId);
  const activityHasMore = activityPage.length > ACTIVITY_PAGE_SIZE;
  const activity = activityHasMore ? activityPage.slice(0, ACTIVITY_PAGE_SIZE) : activityPage;
  const nextActivityCursor = activityHasMore ? activity.at(-1)!.id : null;

  const currency = invoice.currency as Currency;
  const status = getInvoiceStatusDisplay(invoice, financials, dict.invoices);
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
          {t.backToInvoices}
        </Link>

        <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">{invoice.number}</h1>
              <Badge tone={status.tone}>{status.label}</Badge>
              {financials.isOverdue ? (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
                  <CalendarClock className="size-3.5" />
                  {pluralForm(overdueDays, locale, {
                    one: t.overdueDayOne,
                    few: t.overdueDayFew,
                    many: t.overdueDayMany,
                  }).replace("{n}", String(overdueDays))}
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
            trigger={<Button type="button" variant="outline">{t.cancelInvoice}</Button>}
            title={t.cancelDialogTitle}
            description={t.cancelDialogDescription
              .replace("{number}", invoice.number)
              .replace("{customer}", invoice.customer.name)}
          >
            <div className="flex justify-end gap-2">
              <DialogCancelButton className={cn(buttonVariants({ variant: "outline", size: "sm" }))} />
              <form action={boundCancel}>
                <button type="submit" className={cn(buttonVariants({ variant: "destructive", size: "sm" }))}>
                  {t.cancelInvoice}
                </button>
              </form>
            </div>
          </Dialog>
        </div>
      ) : null}

      <Card className="grid grid-cols-2 gap-6 p-6 sm:grid-cols-4">
        <Stat label={t.statOriginalAmount} value={formatMoney(financials.amountMinor, currency)} />
        <Stat label={t.statPaid} value={formatMoney(financials.paidMinor, currency)} tone="success" />
        <Stat label={t.statOutstanding} value={formatMoney(financials.outstandingMinor, currency)} />
        <Stat label={t.statDueDate} value={invoice.dueDate.toISOString().slice(0, 10)} />
      </Card>

      {invoice.notes ? (
        <Card className="p-5">
          <p className="text-xs font-medium text-muted-foreground">{t.notes}</p>
          <p className="mt-1.5 whitespace-pre-wrap text-sm text-foreground">{invoice.notes}</p>
        </Card>
      ) : null}

      <CollectionsStatusBlock
        orgSlug={orgSlug}
        invoiceId={invoiceId}
        status={collectionsStatus}
        isOwner={context.role === "OWNER"}
        t={t}
      />

      {outlook ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t.paymentOutlook}</p>
            <p className="mt-1 text-sm text-foreground">{outlook.explanation}</p>
          </div>
          <Badge tone={OUTLOOK_TONE[outlook.band]}>{OUTLOOK_LABEL[outlook.band]}</Badge>
        </Card>
      ) : null}

      <CopilotPanel
        orgSlug={orgSlug}
        targetId={invoiceId}
        questions={[{ type: "explain_invoice", label: t.copilotQuestion }]}
      />

      {canRecordPayment ? (
        <div className="flex flex-col gap-6">
          <SectionHeader title={t.paymentMethods} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t.bankCard}</p>
              <Card className="mt-2 p-5">
                <RecordPaymentForm action={boundRecordPayment} today={getBusinessToday()} />
              </Card>
            </div>
            <div>
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t.crypto}</p>
              <Card className="mt-2 p-5">
                {cryptoAvailable ? (
                  cryptoRequests.length > 0 ? (
                    <ul className="flex flex-col gap-2.5 text-sm">
                      {cryptoRequests.map((request) => (
                        <li key={request.id} className="flex items-center justify-between gap-3">
                          <span className="text-foreground">
                            {t.cryptoRequestLabel.replace("{asset}", request.asset).replace("{network}", request.network)}
                          </span>
                          <Badge tone={request.status === "OPEN" ? "info" : request.status === "FULFILLED" ? "success" : "neutral"}>
                            {CRYPTO_STATUS_LABEL[request.status] ?? request.status}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted">
                      {t.noCryptoRequestYet}{" "}
                      <Link href={`/app/${orgSlug}/wallet`} className="font-medium text-primary hover:underline">
                        {t.walletLink}
                      </Link>
                      .
                    </p>
                  )
                ) : (
                  <p className="text-sm text-muted">
                    {t.cryptoNotAvailable}{" "}
                    <Link href={`/app/${orgSlug}/wallet`} className="font-medium text-primary hover:underline">
                      {t.walletLink}
                    </Link>{" "}
                    {t.forDetails}
                  </p>
                )}
              </Card>
            </div>
          </div>
        </div>
      ) : null}

      <div>
        <SectionHeader title={t.paymentHistory} />
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
          <EmptyState className="mt-3 py-10" title={t.noPaymentsYet} />
        )}
      </div>

      <div>
        <SectionHeader title={t.activity} />
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
          <p className="mt-3 text-sm text-muted">{t.noActivityYet}</p>
        )}
        {activityHasMore ? (
          <Link
            href={`/app/${orgSlug}/invoices/${invoiceId}?activityCursor=${nextActivityCursor}`}
            className="mt-3 inline-block text-xs font-medium text-primary hover:underline"
          >
            {t.olderActivity}
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
  t,
}: {
  orgSlug: string;
  invoiceId: string;
  status: CollectionStatusView;
  isOwner: boolean;
  t: Dictionary["invoiceDetail"];
}) {
  if (status.kind === "not_enrolled") return null;
  const badge = getCollectionsBadgeView(status);

  if (status.kind === "completed") {
    return (
      <Alert tone="success" title={t.collectionsCompletedTitle}>
        {t.collectionsCompletedDescription}
      </Alert>
    );
  }

  if (status.kind === "stopped") {
    return (
      <Alert tone="neutral" title={t.collectionsStoppedTitle}>
        {status.stopReason
          ? t.collectionsStopReasonPrefix.replace("{reason}", formatStopReason(status.stopReason))
          : t.noFurtherFollowUp}
      </Alert>
    );
  }

  if (status.kind === "blocked_uncertain") {
    return (
      <Alert tone="warning" title={t.collectionsBlockedTitle}>
        <p>{t.collectionsBlockedDescription}</p>
        {isOwner ? (
          <form action={pauseInvoiceCollectionsAction.bind(null, orgSlug, invoiceId, status.sequenceId)} className="mt-3">
            <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              <PauseCircle className="size-4" />
              {t.pauseCollections}
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
          <span className="text-sm text-muted">{t.collectionsPausedDescription}</span>
        </div>
        {isOwner ? (
          <form action={resumeInvoiceCollectionsAction.bind(null, orgSlug, invoiceId, status.sequenceId)}>
            <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              <PlayCircle className="size-4" />
              {t.resume}
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
          <span className="font-medium text-foreground">{t.collectionsInProgress}</span>{" "}
          <span className="text-muted">
            {t.stepProgress
              .replace("{completed}", String(status.stepsCompleted))
              .replace("{total}", String(status.stepCount))}
            {status.nextStepDaysAfterDue !== undefined
              ? t.nextReminderAt.replace("{days}", String(status.nextStepDaysAfterDue))
              : t.allStepsRun}
          </span>
        </div>
      </div>
      {isOwner ? (
        <form action={pauseInvoiceCollectionsAction.bind(null, orgSlug, invoiceId, status.sequenceId)}>
          <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            <PauseCircle className="size-4" />
            {t.pause}
          </button>
        </form>
      ) : null}
    </Card>
  );
}

function formatStopReason(reason: string): string {
  return reason.toLowerCase().replaceAll("_", " ");
}
