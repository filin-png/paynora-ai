import Link from "next/link";
import { RefreshCw, Sparkles } from "lucide-react";

import { AttentionScoreBadge } from "@/components/ui/attention-score";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { CopilotPanel } from "@/components/copilot/copilot-panel";
import { getDictionary } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/get-locale";
import { pluralForm } from "@/lib/i18n/plural";
import { cn } from "@/lib/utils";
import type { Currency } from "@/server/ar/currency";
import { listInvoicesWithFinancials } from "@/server/ar/invoices";
import { formatMoney } from "@/server/ar/money";
import { getAttentionScoresForInvoiceIds } from "@/server/attention/for-invoices";
import { listPendingActionProposals, listRecentlyDecidedActionProposals } from "@/server/operator/approval";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { approveProposalAction, dismissProposalAction, runOperatorAction } from "./actions";

const PRIORITY_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  HIGH: "danger",
  MEDIUM: "warning",
  LOW: "neutral",
};

export default async function ActionCenterPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const locale = await getLocale();
  const dict = getDictionary(locale);
  const t = dict.actionCenter;
  const ACTION_TYPE_LABEL: Record<string, string> = {
    SEND_PAYMENT_REMINDER: t.actionSendPaymentReminder,
  };
  const PRIORITY_LABEL: Record<string, string> = {
    HIGH: t.priorityHighLabel,
    MEDIUM: t.priorityMediumLabel,
    LOW: t.priorityLowLabel,
  };
  const TONE_LABEL: Record<string, string> = {
    SOFT: t.toneSoft,
    STANDARD: t.toneStandard,
    FIRM: t.toneFirm,
  };
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
  const allInvoiceIds = [...new Set([...pendingInvoiceIds, ...decidedInvoiceIds])];
  const [attentionScores, invoicesWithFinancials] = await Promise.all([
    getAttentionScoresForInvoiceIds(context.organization.id, allInvoiceIds, new Set(pendingInvoiceIds)),
    listInvoicesWithFinancials(context.organization.id, "all", { invoiceIds: allInvoiceIds }),
  ]);
  // Financial impact (Phase 22, section 4): each proposal's real
  // outstanding balance — reuses the same `listInvoicesWithFinancials`
  // bulk lookup `attention/for-invoices.ts` and `attention/
  // payment-outlook.ts` already use, never a second per-proposal query.
  const outstandingByInvoiceId = new Map(
    invoicesWithFinancials.map(({ invoice, financials }) => [invoice.id, { outstandingMinor: financials.outstandingMinor, currency: invoice.currency as Currency }]),
  );

  const boundRunOperator = runOperatorAction.bind(null, orgSlug);

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          <form action={boundRunOperator}>
            <Button type="submit" variant="outline">
              <RefreshCw className="size-4" />
              {t.checkForNewActions}
            </Button>
          </form>
        }
      />

      <div>
        <SectionHeader
          title={t.pendingReview}
          description={
            pending.length > 0
              ? pluralForm(pending.length, locale, {
                  one: t.awaitingDecisionOne,
                  few: t.awaitingDecisionFew,
                  many: t.awaitingDecisionMany,
                }).replace("{n}", String(pending.length))
              : undefined
          }
        />
        {pending.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-3">
            {pending.map((proposal) => {
              const boundApprove = approveProposalAction.bind(null, orgSlug, proposal.id);
              const boundDismiss = dismissProposalAction.bind(null, orgSlug, proposal.id);
              const attention = proposal.invoiceId ? attentionScores.get(proposal.invoiceId) : undefined;
              const impact = proposal.invoiceId ? outstandingByInvoiceId.get(proposal.invoiceId) : undefined;
              return (
                <li key={proposal.id} className="flex flex-col gap-2">
                  <Card className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={PRIORITY_TONE[proposal.insight.priority] ?? "neutral"}>
                          {PRIORITY_LABEL[proposal.insight.priority] ?? proposal.insight.priority}
                        </Badge>
                        {attention ? <AttentionScoreBadge score={attention.attention.score} /> : null}
                        {impact ? (
                          <Badge tone="neutral">{t.atStake.replace("{amount}", formatMoney(impact.outstandingMinor, impact.currency))}</Badge>
                        ) : null}
                        <span className="text-sm font-medium text-foreground">
                          {ACTION_TYPE_LABEL[proposal.type] ?? proposal.type}
                        </span>
                        {proposal.suggestedTone ? (
                          <span className="text-xs text-muted-foreground">
                            {t.toneSuffix.replace("{tone}", TONE_LABEL[proposal.suggestedTone] ?? proposal.suggestedTone.toLowerCase())}
                          </span>
                        ) : null}
                      </div>
                      <p className="text-sm text-muted">{proposal.reasoning}</p>
                      <p className="text-xs text-muted-foreground">
                        {t.detectedAutomatically.replace("{date}", proposal.insight.createdAt.toISOString().slice(0, 10))}
                      </p>
                      {proposal.invoice ? (
                        <Link
                          href={`/app/${orgSlug}/invoices/${proposal.invoice.id}`}
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          {proposal.invoice.number} — {proposal.invoice.customer.name}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t.invoiceNoLongerAvailable}</span>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <form action={boundDismiss}>
                        <button type="submit" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                          {t.dismiss}
                        </button>
                      </form>
                      <form action={boundApprove}>
                        <button type="submit" className={cn(buttonVariants({ size: "sm" }))}>
                          {t.approve}
                        </button>
                      </form>
                    </div>
                  </Card>
                  <CopilotPanel
                    orgSlug={orgSlug}
                    targetId={proposal.id}
                    questions={[{ type: "why_important", label: t.copilotWhyImportant }]}
                  />
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            className="mt-3"
            icon={Sparkles}
            title={t.nothingNeedsAttention}
            description={t.clickCheckForNewActions}
          />
        )}
      </div>

      <div>
        <SectionHeader title={t.recentlyDecided} />
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
                    {/* Audit trail (Phase 22, section 4): decidedByUserId/decidedAt were
                        already recorded atomically by transitionActionProposal
                        (src/server/operator/approval.ts) — this only surfaces them.
                        STALE proposals were never decided by a human, so there is
                        no actor to show for those. */}
                    {proposal.decidedByUser && proposal.decidedAt ? (
                      <span className="text-xs text-muted-foreground">
                        {t.decidedBy
                          .replace("{name}", proposal.decidedByUser.name ?? proposal.decidedByUser.email)
                          .replace("{date}", proposal.decidedAt.toISOString().slice(0, 10))}
                      </span>
                    ) : null}
                  </div>
                  {proposal.status === "DISMISSED" ? (
                    <Badge tone="neutral">{t.dismissed}</Badge>
                  ) : proposal.status === "STALE" ? (
                    <Badge tone="neutral">{t.stale}</Badge>
                  ) : proposal.status === "EXECUTED" ? (
                    <Link href={`/app/${orgSlug}/actions/${proposal.id}`}>
                      <Badge tone="success">{t.sent}</Badge>
                    </Link>
                  ) : (
                    <Link href={`/app/${orgSlug}/actions/${proposal.id}`} className="hover:underline">
                      <Badge tone="warning">{t.approvedReviewSend}</Badge>
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <EmptyState className="mt-3 py-10" title={t.noDecisionsYet} />
        )}
      </div>
    </div>
  );
}
