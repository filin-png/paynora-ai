import Link from "next/link";
import { WalletIcon } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDictionary } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/get-locale";
import { isWalletEnabled } from "@/server/wallet/service";
import { listWalletTransactions } from "@/server/wallet/transactions";
import { listWallets } from "@/server/wallet/wallets";
import { requireOrganizationMembershipForPage } from "@/server/tenancy/guards";
import {
  RECONCILIATION_TONE,
  TRANSACTION_STATUS_TONE,
  WALLET_STATUS_TONE,
  reconciliationLabel,
  shortenAddress,
  transactionStatusLabel,
  walletStatusLabel,
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
  const locale = await getLocale();
  const t = getDictionary(locale).wallet;
  const WALLET_STATUS_LABEL = walletStatusLabel(t);
  const TX_STATUS_LABEL = transactionStatusLabel(t);
  const context = await requireOrganizationMembershipForPage(orgSlug);
  const [wallets, transactions] = await Promise.all([
    listWallets(context.organization.id),
    listWalletTransactions(context.organization.id),
  ]);
  const enabled = isWalletEnabled();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t.title} description={t.description} />

      {!enabled ? (
        <Alert tone="neutral" title={t.noProviderTitle}>
          {t.noProviderBody}
        </Alert>
      ) : null}

      <div>
        <SectionHeader title={t.connectedWallets} />
        {wallets.length > 0 ? (
          <TableContainer className="mt-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.columnAddress}</TableHead>
                  <TableHead>{t.columnNetwork}</TableHead>
                  <TableHead>{t.columnProvider}</TableHead>
                  <TableHead>{t.columnStatus}</TableHead>
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
            title={t.noWalletsTitle}
            description={enabled ? t.noWalletsDescriptionEnabled : t.noWalletsDescriptionDisabled}
          />
        )}
      </div>

      <div>
        <SectionHeader title={t.recentTransactions} description={t.recentTransactionsDescription} />
        {transactions.length > 0 ? (
          <TableContainer className="mt-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.columnTransaction}</TableHead>
                  <TableHead>{t.columnAsset}</TableHead>
                  <TableHead>{t.columnDirection}</TableHead>
                  <TableHead>{t.columnStatus}</TableHead>
                  <TableHead>{t.columnReconciliation}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transactions.map((tx) => (
                  <TableRow key={tx.id}>
                    <TableCell className="font-mono text-xs text-foreground">{shortenAddress(tx.txHash)}</TableCell>
                    <TableCell className="text-muted">{tx.asset}</TableCell>
                    <TableCell className="text-muted">{tx.direction === "INCOMING" ? t.directionIncoming : t.directionOutgoing}</TableCell>
                    <TableCell>
                      <Badge tone={TRANSACTION_STATUS_TONE[tx.status]}>{TX_STATUS_LABEL[tx.status]}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge tone={tx.reconciliationOutcome ? RECONCILIATION_TONE[tx.reconciliationOutcome] : "neutral"}>
                        {reconciliationLabel(t, tx.reconciliationOutcome, tx.reconciliationRejectionReason)}
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
            title={t.noTransactionsTitle}
            description={t.noTransactionsDescriptionList}
          />
        )}
      </div>
    </div>
  );
}
