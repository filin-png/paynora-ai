import Link from "next/link";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listPendingActionProposals, listRecentlyDecidedActionProposals } from "@/server/operator/approval";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { approveProposalAction, dismissProposalAction, runOperatorAction } from "./actions";

const PRIORITY_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  HIGH: "danger",
  MEDIUM: "warning",
  LOW: "neutral",
};

const ACTION_TYPE_LABEL: Record<string, string> = {
  SEND_PAYMENT_REMINDER: "Send a payment reminder",
};

export default async function ActionCenterPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const [pending, decided] = await Promise.all([
    listPendingActionProposals(context.organization.id),
    listRecentlyDecidedActionProposals(context.organization.id),
  ]);

  const boundRunOperator = runOperatorAction.bind(null, orgSlug);

  return (
    <div className="flex flex-col gap-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Action Center</h1>
          <p className="mt-1 text-sm text-muted">
            Proposed actions from deterministic checks (and, where available, AI-assisted wording) —
            nothing here is sent automatically. Every action needs your approval, and approving does not
            send anything yet either.
          </p>
        </div>
        <form action={boundRunOperator}>
          <button type="submit" className={cn(buttonVariants({ variant: "outline" }))}>
            Run Operator
          </button>
        </form>
      </div>

      <div>
        <h2 className="text-sm font-semibold">Pending your review</h2>
        {pending.length > 0 ? (
          <ul className="mt-3 flex flex-col divide-y divide-border rounded-md border border-border">
            {pending.map((proposal) => {
              const boundApprove = approveProposalAction.bind(null, orgSlug, proposal.id);
              const boundDismiss = dismissProposalAction.bind(null, orgSlug, proposal.id);
              return (
                <li key={proposal.id} className="flex flex-col gap-3 px-4 py-4 text-sm sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <Badge tone={PRIORITY_TONE[proposal.insight.priority] ?? "neutral"}>
                        {proposal.insight.priority}
                      </Badge>
                      <span className="font-medium">
                        {ACTION_TYPE_LABEL[proposal.type] ?? proposal.type}
                      </span>
                      {proposal.suggestedTone ? (
                        <span className="text-xs text-muted">({proposal.suggestedTone} tone)</span>
                      ) : null}
                    </div>
                    <p className="text-muted">{proposal.reasoning}</p>
                    {proposal.invoice ? (
                      <Link
                        href={`/app/${orgSlug}/invoices/${proposal.invoice.id}`}
                        className="text-xs text-muted hover:underline"
                      >
                        View invoice {proposal.invoice.number} — {proposal.invoice.customer.name}
                      </Link>
                    ) : (
                      <span className="text-xs text-muted">Invoice no longer available</span>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <form action={boundDismiss}>
                      <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                        Dismiss
                      </button>
                    </form>
                    <form action={boundApprove}>
                      <button type="submit" className={cn(buttonVariants({ variant: "primary", size: "sm" }))}>
                        Approve
                      </button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted">
            Nothing pending. Click &ldquo;Run Operator&rdquo; to check for newly overdue invoices.
          </p>
        )}
      </div>

      <div>
        <h2 className="text-sm font-semibold">Recently decided</h2>
        {decided.length > 0 ? (
          <ul className="mt-3 flex flex-col divide-y divide-border rounded-md border border-border">
            {decided.map((proposal) => (
              <li key={proposal.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                <div className="flex flex-col gap-1">
                  <span>{ACTION_TYPE_LABEL[proposal.type] ?? proposal.type}</span>
                  {proposal.invoice ? (
                    <span className="text-xs text-muted">
                      {proposal.invoice.number} — {proposal.invoice.customer.name}
                    </span>
                  ) : null}
                </div>
                {proposal.status === "APPROVED" ? (
                  <Badge tone="success">Approved — execution is not enabled yet</Badge>
                ) : (
                  <Badge tone="neutral">Dismissed</Badge>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted">No decisions made yet.</p>
        )}
      </div>
    </div>
  );
}
