import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CircleAlert, ShieldCheck, WalletIcon } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isResourceNotFoundError } from "@/lib/not-found";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import { formatAssetAmount } from "@/server/wallet/amount";
import { getWalletBalances, type WalletBalancesResult } from "@/server/wallet/balances";
import { isWalletEnabled, resolveWalletProvider } from "@/server/wallet/service";
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
        <SectionHeader title="Balances" />
        <div className="mt-3">
          <Suspense fallback={<BalancesLoading />}>
            <BalancesCard organizationId={context.organization.id} walletId={wallet.id} />
          </Suspense>
        </div>
      </div>

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

function BalancesLoading() {
  return (
    <Card className="flex flex-col gap-3 p-6">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-4 w-48" />
    </Card>
  );
}

/**
 * Real data only — never a mock/demo balance. Resolves the provider
 * itself (mirrors the wallet webhook route's own resolution pattern,
 * src/app/api/webhooks/wallet/[orgSlug]/route.ts) so "no provider
 * configured" is a state this component decides before ever calling
 * getWalletBalances, which itself never resolves a provider — see
 * src/server/wallet/balances.ts.
 */
async function BalancesCard({ organizationId, walletId }: { organizationId: string; walletId: string }) {
  if (!isWalletEnabled()) {
    return (
      <EmptyState
        icon={CircleAlert}
        title="Wallet provider not available"
        description="No wallet provider is configured for this deployment — balances can't be checked right now."
      />
    );
  }

  let provider;
  try {
    provider = resolveWalletProvider();
  } catch {
    return (
      <EmptyState
        icon={CircleAlert}
        title="Wallet provider not available"
        description="The configured wallet provider could not be resolved — balances can't be checked right now."
      />
    );
  }

  const result: WalletBalancesResult = await getWalletBalances(organizationId, walletId, provider);

  if (result.status === "not_connected") {
    return (
      <EmptyState
        icon={WalletIcon}
        title="Not connected yet"
        description="Balances are available once this wallet has completed ownership verification."
      />
    );
  }

  if (result.status === "error") {
    return (
      <EmptyState
        icon={CircleAlert}
        title="Couldn't load balances"
        description="The wallet provider didn't respond. Try again shortly."
      />
    );
  }

  if (result.balances.length === 0) {
    return <EmptyState icon={WalletIcon} title="No balances" description="This wallet currently holds no observed assets." />;
  }

  return (
    <TableContainer>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Asset</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Chain</TableHead>
            <TableHead>Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.balances.map((balance, index) => (
            <TableRow key={`${balance.chain}-${balance.asset}-${index}`}>
              <TableCell className="font-medium text-foreground">{balance.asset}</TableCell>
              <TableCell className="text-muted">{balance.assetType === "native" ? "Native" : "Token"}</TableCell>
              <TableCell className="text-muted">{balance.chain}</TableCell>
              <TableCell className="font-mono text-xs text-foreground">
                {formatAssetAmount(balance.amountMinor, balance.assetDecimals)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
