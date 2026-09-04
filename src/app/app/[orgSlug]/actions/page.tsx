import Link from "next/link";
import { RefreshCw, Sparkles } from "lucide-react";

import { AttentionScoreBadge } from "@/components/ui/attention-score";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { getAttentionScoresForInvoiceIds } from "@/server/attention/for-invoices";
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

  // Attention scores for every invoice shown on this page, computed once —
  // see src/server/attention/for-invoices.ts. Pending proposals' invoices
  // are, by definition, the ones with an unresolved action right now;
  // decided/stale ones no longer are.
  const pendingInvoiceIds = pending.map((p) => p.invoiceId).filter((id): id is string => id !== null);
  const decidedInvoiceIds = decided.map((p) => p.invoiceId).filter((id): id is string => id !== null);
  const attentionScores = await getAttentionScoresForInvoiceIds(
    context.organization.id,
    [...new Set([...pendingInvoiceIds, ...decidedInvoiceIds])],
    new Set(pendingInvoiceIds),
  );

  const boundRunOperator = runOperatorAction.bind(null, orgSlug);

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Action Center"
        description="Every action here needs your approval, and approving doesn't send anything by itself — review and send is a separate, explicit step."
        actions={
          <form action={boundRunOperator}>
            <Button type="submit" variant="outline">
              <RefreshCw className="size-4" />
              Check for new actions
            </Button>
          </form>
        }
      />

      <div>
        <SectionHeader title="Pending your review" description={pending.length > 0 ? `${pending.length} awaiting a decision` : undefined} />
        {pending.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-3">
            {pending.map((proposal) => {
              const boundApprove = approveProposalAction.bind(null, orgSlug, proposal.id);
              const boundDismiss = dismissProposalAction.bind(null, orgSlug, proposal.id);
              const attention = proposal.invoiceId ? attentionScores.get(proposal.invoiceId) : undefined;
              return (
                <li key={proposal.id}>
                  <Card className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={PRIORITY_TONE[proposal.insight.priority] ?? "neutral"}>
                          {proposal.insight.priority.charAt(0) + proposal.insight.priority.slice(1).toLowerCase()} priority
                        </Badge>
                        {attention ? <AttentionScoreBadge score={attention.attention.score} /> : null}
                        <span className="text-sm font-medium text-foreground">
                          {ACTION_TYPE_LABEL[proposal.type] ?? proposal.type}
                        </span>
                        {proposal.suggestedTone ? (
                          <span className="text-xs text-muted-foreground">({proposal.suggestedTone.toLowerCase()} tone)</span>
                        ) : null}
                      </div>
                      <p className="text-sm text-muted">{proposal.reasoning}</p>
                      <p className="text-xs text-muted-foreground">
                        Detected automatically {proposal.insight.createdAt.toISOString().slice(0, 10)} — this proposal
                        follows directly from that insight; approving it never sends anything by itself.
                      </p>
                      {proposal.invoice ? (
                        <Link
                          href={`/app/${orgSlug}/invoices/${proposal.invoice.id}`}
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          {proposal.invoice.number} — {proposal.invoice.customer.name}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">Invoice no longer available</span>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <form action={boundDismiss}>
                        <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                          Dismiss
                        </button>
                      </form>
                      <form action={boundApprove}>
                        <button type="submit" className={cn(buttonVariants({ size: "sm" }))}>
                          Approve
                        </button>
                      </form>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            className="mt-3"
            icon={Sparkles}
            title="Nothing needs your attention"
            description="Click “Check for new actions” to look for newly overdue invoices."
          />
        )}
      </div>

      <div>
        <SectionHeader title="Recently decided" />
        {decided.length > 0 ? (
          <Card className="mt-3 overflow-hidden">
            <ul className="divide-y divide-border">
              {decided.map((proposal) => (
                <li key={proposal.id} className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-foreground">{ACTION_TYPE_LABEL[proposal.type] ?? proposal.type}</span>
                    {proposal.invoice ? (
                      <span className="text-xs text-muted">
                        {proposal.invoice.number} — {proposal.invoice.customer.name}
                      </span>
                    ) : null}
                  </div>
                  {proposal.status === "DISMISSED" ? (
                    <Badge tone="neutral">Dismissed</Badge>
                  ) : proposal.status === "STALE" ? (
                    <Badge tone="neutral">Stale — no longer needed</Badge>
                  ) : proposal.status === "EXECUTED" ? (
                    <Link href={`/app/${orgSlug}/actions/${proposal.id}`}>
                      <Badge tone="success">Sent</Badge>
                    </Link>
                  ) : (
                    <Link href={`/app/${orgSlug}/actions/${proposal.id}`} className="hover:underline">
                      <Badge tone="warning">Approved — review &amp; send</Badge>
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <EmptyState className="mt-3 py-10" title="No decisions made yet" />
        )}
      </div>
    </div>
  );
}
