import Link from "next/link";
import { WalletIcon } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isWalletEnabled } from "@/server/wallet/service";
import { listWalletTransactions } from "@/server/wallet/transactions";
import { listWallets } from "@/server/wallet/wallets";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import {
  RECONCILIATION_TONE,
  TRANSACTION_STATUS_TONE,
  WALLET_STATUS_LABEL,
  WALLET_STATUS_TONE,
  reconciliationLabel,
  shortenAddress,
} from "./format";

/**
 * Wallet overview — see docs/wallet-architecture.md#ui-behavior. Never
 * displays a fabricated balance or transaction: every row here comes
 * straight from listWallets/listWalletTransactions, which are empty in any
 * deployment that hasn't connected a real wallet provider (the default,
 * WALLET_PROVIDER=none). The "no provider connected" banner is the honest
 * readiness signal the phase brief requires — it never claims the wallet
 * feature is live when it isn't.
 */
export default async function WalletPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const [wallets, transactions] = await Promise.all([
    listWallets(context.organization.id),
    listWalletTransactions(context.organization.id),
  ]);
  const enabled = isWalletEnabled();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Wallet"
        description="Crypto wallets connected to this organization and the on-chain transactions PAYNORA has observed for them."
      />

      {!enabled ? (
        <Alert tone="neutral" title="No production wallet provider connected">
          This deployment has no live wallet/blockchain provider configured. The wallet architecture — connections,
          transaction tracking, and payment reconciliation — is built and ready, but no real provider is wired up in
          this phase, so no crypto payment can actually be received yet. See Settings → Integrations for the current
          configuration.
        </Alert>
      ) : null}

      <div>
        <SectionHeader title="Connected wallets" />
        {wallets.length > 0 ? (
          <TableContainer className="mt-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Address</TableHead>
                  <TableHead>Network</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wallets.map((wallet) => (
                  <TableRow key={wallet.id}>
                    <TableCell className="p-0">
                      <Link
                        href={`/app/${orgSlug}/wallet/${wallet.id}`}
                        className="flex items-center gap-2 px-4 py-3.5 font-medium text-foreground"
                      >
                        {wallet.label ?? shortenAddress(wallet.address)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted">{wallet.network}</TableCell>
                    <TableCell className="text-muted">{wallet.providerName}</TableCell>
                    <TableCell>
                      <Badge tone={WALLET_STATUS_TONE[wallet.status]}>{WALLET_STATUS_LABEL[wallet.status]}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : (
          <EmptyState
            icon={WalletIcon}
            className="mt-3"
            title="No wallets connected"
            description={
              enabled
                ? "Connect a wallet to start accepting crypto payments against your invoices."
                : "No production provider is connected in this deployment, so there is nothing to connect yet — see the notice above."
            }
          />
        )}
      </div>

      <div>
        <SectionHeader title="Recent transactions" description="Across every connected wallet, most recent first." />
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
          <EmptyState
            className="mt-3"
            title="No transactions yet"
            description="On-chain transactions PAYNORA observes for your connected wallets will appear here."
          />
        )}
      </div>
    </div>
  );
}
