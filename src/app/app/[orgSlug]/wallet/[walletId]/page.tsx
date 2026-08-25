import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ShieldCheck } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/page-header";
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isResourceNotFoundError } from "@/lib/not-found";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { listWalletTransactions } from "@/server/wallet/transactions";
import { getWallet } from "@/server/wallet/wallets";
import {
  RECONCILIATION_TONE,
  TRANSACTION_STATUS_TONE,
  WALLET_STATUS_LABEL,
  WALLET_STATUS_TONE,
  reconciliationLabel,
  shortenAddress,
} from "../format";

export default async function WalletDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; walletId: string }>;
}) {
  const { orgSlug, walletId } = await params;
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const wallet = await getWallet(context.organization.id, walletId).catch((error: unknown) => {
    if (isResourceNotFoundError(error)) notFound();
    throw error;
  });
  const transactions = await listWalletTransactions(context.organization.id, { walletId });

  return (
    <div className="flex flex-col gap-8">
      <div>
        <Link
          href={`/app/${orgSlug}/wallet`}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Wallet
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {wallet.label ?? shortenAddress(wallet.address)}
          </h1>
          <Badge tone={WALLET_STATUS_TONE[wallet.status]}>{WALLET_STATUS_LABEL[wallet.status]}</Badge>
        </div>
      </div>

      <Card className="grid grid-cols-2 gap-6 p-6 sm:grid-cols-4">
        <Stat label="Network" value={wallet.network} />
        <Stat label="Provider" value={wallet.providerName} />
        <Stat label="Address" value={wallet.address} mono />
        <Stat
          label="Connected"
          value={wallet.connectedAt ? wallet.connectedAt.toISOString().slice(0, 10) : "Not yet verified"}
        />
      </Card>

      <Alert tone="neutral" title="Security">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <p>
            PAYNORA never stores this wallet&rsquo;s private key or seed phrase. This address is monitored read-only —
            PAYNORA can observe incoming transactions to it, but cannot move funds out of it.
          </p>
        </div>
      </Alert>

      <div>
        <SectionHeader title="Transaction history" />
        {transactions.length > 0 ? (
          <TableContainer className="mt-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Transaction</TableHead>
                  <TableHead>Asset</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reconciliation</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transactions.map((tx) => (
                  <TableRow key={tx.id}>
                    <TableCell className="font-mono text-xs text-foreground">{shortenAddress(tx.txHash)}</TableCell>
                    <TableCell className="text-muted">{tx.asset}</TableCell>
                    <TableCell className="text-muted">{tx.direction === "INCOMING" ? "Incoming" : "Outgoing"}</TableCell>
                    <TableCell>
                      <Badge tone={TRANSACTION_STATUS_TONE[tx.status]}>{tx.status}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge tone={tx.reconciliationOutcome ? RECONCILIATION_TONE[tx.reconciliationOutcome] : "neutral"}>
                        {reconciliationLabel(tx.reconciliationOutcome, tx.reconciliationRejectionReason)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : (
          <EmptyState className="mt-3" title="No transactions yet" description="Nothing has been observed for this wallet yet." />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={`mt-1 text-sm font-semibold text-foreground ${mono ? "font-mono text-xs break-all" : ""}`}>{value}</p>
    </div>
  );
}
