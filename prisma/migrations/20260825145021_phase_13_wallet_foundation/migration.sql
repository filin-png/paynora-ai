-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "CryptoPaymentRequestStatus" AS ENUM ('OPEN', 'FULFILLED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "WalletTransactionDirection" AS ENUM ('INCOMING', 'OUTGOING');

-- CreateEnum
CREATE TYPE "WalletTransactionStatus" AS ENUM ('DETECTED', 'CONFIRMING', 'CONFIRMED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ReconciliationOutcome" AS ENUM ('MATCHED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReconciliationRejectionReason" AS ENUM ('NO_MATCHING_WALLET', 'NO_OPEN_PAYMENT_REQUEST', 'INVOICE_ALREADY_SETTLED', 'UNDERPAID', 'TRANSACTION_FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityEventType" ADD VALUE 'WALLET_CONNECTED';
ALTER TYPE "ActivityEventType" ADD VALUE 'WALLET_DISCONNECTED';
ALTER TYPE "ActivityEventType" ADD VALUE 'WALLET_TRANSACTION_DETECTED';
ALTER TYPE "ActivityEventType" ADD VALUE 'WALLET_TRANSACTION_CONFIRMED';
ALTER TYPE "ActivityEventType" ADD VALUE 'WALLET_PAYMENT_RECONCILED';
ALTER TYPE "ActivityEventType" ADD VALUE 'WALLET_RECONCILIATION_REJECTED';
ALTER TYPE "ActivityEventType" ADD VALUE 'WALLET_WEBHOOK_REJECTED';

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT,
    "providerName" TEXT NOT NULL,
    "providerWalletId" TEXT,
    "status" "WalletStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crypto_payment_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "assetDecimals" INTEGER NOT NULL,
    "expectedAssetAmountMinor" BIGINT NOT NULL,
    "requestedAmountMinor" BIGINT NOT NULL,
    "status" "CryptoPaymentRequestStatus" NOT NULL DEFAULT 'OPEN',
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crypto_payment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "direction" "WalletTransactionDirection" NOT NULL,
    "asset" TEXT NOT NULL,
    "assetDecimals" INTEGER NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "fromAddress" TEXT,
    "toAddress" TEXT NOT NULL,
    "status" "WalletTransactionStatus" NOT NULL DEFAULT 'DETECTED',
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "requiredConfirmations" INTEGER NOT NULL DEFAULT 1,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "providerName" TEXT NOT NULL,
    "providerEventId" TEXT,
    "matchedRequestId" TEXT,
    "reconciliationOutcome" "ReconciliationOutcome",
    "reconciliationRejectionReason" "ReconciliationRejectionReason",
    "reconciledPaymentId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wallets_organizationId_idx" ON "wallets"("organizationId");

-- CreateIndex
CREATE INDEX "wallets_organizationId_status_idx" ON "wallets"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_network_address_key" ON "wallets"("network", "address");

-- CreateIndex
CREATE INDEX "crypto_payment_requests_organizationId_idx" ON "crypto_payment_requests"("organizationId");

-- CreateIndex
CREATE INDEX "crypto_payment_requests_walletId_network_asset_status_creat_idx" ON "crypto_payment_requests"("walletId", "network", "asset", "status", "createdAt");

-- CreateIndex
CREATE INDEX "crypto_payment_requests_invoiceId_idx" ON "crypto_payment_requests"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_reconciledPaymentId_key" ON "wallet_transactions"("reconciledPaymentId");

-- CreateIndex
CREATE INDEX "wallet_transactions_organizationId_idx" ON "wallet_transactions"("organizationId");

-- CreateIndex
CREATE INDEX "wallet_transactions_organizationId_status_idx" ON "wallet_transactions"("organizationId", "status");

-- CreateIndex
CREATE INDEX "wallet_transactions_walletId_idx" ON "wallet_transactions"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_network_txHash_key" ON "wallet_transactions"("network", "txHash");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crypto_payment_requests" ADD CONSTRAINT "crypto_payment_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crypto_payment_requests" ADD CONSTRAINT "crypto_payment_requests_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crypto_payment_requests" ADD CONSTRAINT "crypto_payment_requests_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crypto_payment_requests" ADD CONSTRAINT "crypto_payment_requests_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_matchedRequestId_fkey" FOREIGN KEY ("matchedRequestId") REFERENCES "crypto_payment_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_reconciledPaymentId_fkey" FOREIGN KEY ("reconciledPaymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
