import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listInvoiceActivity } from "@/server/ar/activity";
import type { Currency } from "@/server/ar/currency";
import { getBusinessToday } from "@/server/ar/dates";
import { getInvoiceWithFinancials } from "@/server/ar/invoices";
import { formatMoney } from "@/server/ar/money";
import { listPaymentsForInvoice } from "@/server/ar/payments";
import { getCollectionStatusForInvoice, type CollectionStatusView } from "@/server/collections/sequences";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { getInvoiceStatusDisplay } from "../status";
import {
  cancelInvoiceAction,
  pauseInvoiceCollectionsAction,
  recordPaymentAction,
  resumeInvoiceCollectionsAction,
} from "./actions";
import { RecordPaymentForm } from "./payment-form";

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; invoiceId: string }>;
}) {
  const { orgSlug, invoiceId } = await params;
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const { invoice, financials } = await getInvoiceWithFinancials(context.organization.id, invoiceId);
  const [payments, activity, collectionsStatus] = await Promise.all([
    listPaymentsForInvoice(context.organization.id, invoiceId),
    listInvoiceActivity(context.organization.id, invoiceId),
    getCollectionStatusForInvoice(context.organization.id, invoiceId),
  ]);

  const currency = invoice.currency as Currency;
  const status = getInvoiceStatusDisplay(invoice, financials);
  const canRecordPayment = invoice.status === "OPEN" && financials.outstandingMinor > 0n;
  const canCancel = invoice.status === "OPEN" && financials.paidMinor === 0n;

  const boundRecordPayment = recordPaymentAction.bind(null, orgSlug, invoiceId);
  const boundCancel = cancelInvoiceAction.bind(null, orgSlug, invoiceId);

  return (
    <div className="flex flex-col gap-10">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{invoice.number}</h1>
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">
            <Link href={`/app/${orgSlug}/customers/${invoice.customerId}`} className="hover:underline">
              {invoice.customer.name}
            </Link>
          </p>
        </div>
        {canCancel ? (
          <form action={boundCancel}>
            <button type="submit" className={cn(buttonVariants({ variant: "outline" }))}>
              Cancel invoice
            </button>
          </form>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-6 rounded-md border border-border p-6 sm:grid-cols-4">
        <div>
          <p className="text-xs text-muted">Original amount</p>
          <p className="mt-1 text-lg font-semibold">{formatMoney(financials.amountMinor, currency)}</p>
        </div>
        <div>
          <p className="text-xs text-muted">Paid</p>
          <p className="mt-1 text-lg font-semibold">{formatMoney(financials.paidMinor, currency)}</p>
        </div>
        <div>
          <p className="text-xs text-muted">Outstanding</p>
          <p className="mt-1 text-lg font-semibold">{formatMoney(financials.outstandingMinor, currency)}</p>
        </div>
        <div>
          <p className="text-xs text-muted">Due date</p>
          <p className="mt-1 text-lg font-semibold">{invoice.dueDate.toISOString().slice(0, 10)}</p>
        </div>
      </div>

      {invoice.notes ? <p className="whitespace-pre-wrap text-sm text-muted">{invoice.notes}</p> : null}

      <CollectionsStatusBlock
        orgSlug={orgSlug}
        invoiceId={invoiceId}
        status={collectionsStatus}
        isOwner={context.role === "OWNER"}
      />

      {canRecordPayment ? (
        <div>
          <h2 className="text-sm font-semibold">Record a payment</h2>
          <div className="mt-3 max-w-md">
            <RecordPaymentForm action={boundRecordPayment} today={getBusinessToday()} />
          </div>
        </div>
      ) : null}

      <div>
        <h2 className="text-sm font-semibold">Payments</h2>
        {payments.length > 0 ? (
          <ul className="mt-3 flex flex-col divide-y divide-border rounded-md border border-border">
            {payments.map((payment) => (
              <li key={payment.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <span>{payment.paidAt.toISOString().slice(0, 10)}</span>
                {payment.note ? <span className="text-muted">{payment.note}</span> : null}
                <span className="font-medium">{formatMoney(payment.amountMinor, currency)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted">No payments recorded yet.</p>
        )}
      </div>

      <div>
        <h2 className="text-sm font-semibold">Activity</h2>
        {activity.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {activity.map((event) => (
              <li key={event.id} className="flex justify-between gap-4 text-muted">
                <span>{event.summary}</span>
                <span className="shrink-0">{event.createdAt.toISOString().slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted">No activity yet.</p>
        )}
      </div>
    </div>
  );
}

/**
 * Honest, per-state collections display — never claims collections are
 * "in progress" for a paid invoice, and explicitly says when a previous
 * email's delivery status is unresolved rather than silently doing
 * nothing. See docs/collections-automation.md#ui.
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

  if (status.kind === "completed") {
    return (
      <div className="rounded-md border border-emerald-600/30 bg-emerald-600/10 p-4 text-sm text-emerald-700 dark:text-emerald-400">
        Collections completed — invoice paid.
      </div>
    );
  }

  if (status.kind === "stopped") {
    return (
      <div className="rounded-md border border-border p-4 text-sm text-muted">
        Collections stopped ({status.stopReason ?? "unknown reason"}).
      </div>
    );
  }

  if (status.kind === "blocked_uncertain") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-amber-600/30 bg-amber-600/10 p-4 text-sm">
        <p className="font-medium text-amber-700 dark:text-amber-400">Automation paused</p>
        <p className="text-muted">
          Previous email delivery status is uncertain — manual review required before another reminder can be
          scheduled automatically.
        </p>
        {isOwner ? (
          <form action={pauseInvoiceCollectionsAction.bind(null, orgSlug, invoiceId, status.sequenceId)} className="mt-1">
            <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              Pause collections
            </button>
          </form>
        ) : null}
      </div>
    );
  }

  if (status.kind === "paused") {
    return (
      <div className="flex items-center justify-between gap-4 rounded-md border border-border p-4 text-sm">
        <span className="text-muted">Collections: paused</span>
        {isOwner ? (
          <form action={resumeInvoiceCollectionsAction.bind(null, orgSlug, invoiceId, status.sequenceId)}>
            <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              Resume
            </button>
          </form>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-border p-4 text-sm">
      <div>
        <p className="font-medium">Collections: active</p>
        <p className="mt-1 text-xs text-muted">
          Step {status.stepsCompleted} of {status.stepCount}
          {status.nextStepDaysAfterDue !== undefined
            ? ` — next reminder at day +${status.nextStepDaysAfterDue} overdue`
            : " — all configured steps have run"}
        </p>
      </div>
      {isOwner ? (
        <form action={pauseInvoiceCollectionsAction.bind(null, orgSlug, invoiceId, status.sequenceId)}>
          <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            Pause
          </button>
        </form>
      ) : null}
    </div>
  );
}
