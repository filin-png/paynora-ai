import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { createTestWalletProvider, serializeTestWalletEvent, signTestWalletWebhookBody } from "./providers/fake";
import type { RawWalletEvent } from "./provider-types";
import { createActiveTestWallet } from "./test-fixtures";
import { ingestWalletWebhookEvent } from "./transactions";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const SECRET = "test-wallet-webhook-secret";
const provider = createTestWalletProvider({ webhookSecret: SECRET });

function baseEvent(overrides: Partial<RawWalletEvent> = {}): RawWalletEvent {
  return {
    network: "ETHEREUM",
    txHash: `0xhash-${Math.random().toString(36).slice(2, 10)}`,
    direction: "INCOMING",
    asset: "USDT",
    assetDecimals: 6,
    amountMinor: 500_000_000n,
    fromAddress: "0xcustomer",
    toAddress: "0xmerchant",
    status: "DETECTED",
    confirmations: 0,
    requiredConfirmations: 3,
    observedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

describe("ingestWalletWebhookEvent — webhook security", () => {
  it("rejects a delivery with an invalid signature and records WALLET_WEBHOOK_REJECTED", async () => {
    const { organization } = await createTestOrganization();
    const body = serializeTestWalletEvent(baseEvent());

    const result = await ingestWalletWebhookEvent(organization.id, body, "not-a-real-signature", provider);

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") expect(result.reason).toBe("signature_verification_failed");
    const events = await prisma.activityEvent.findMany({ where: { organizationId: organization.id } });
    expect(events.some((e) => e.type === "WALLET_WEBHOOK_REJECTED")).toBe(true);
  });

  it("rejects a malformed payload even with a valid signature over that malformed body", async () => {
    const { organization } = await createTestOrganization();
    const body = "not valid json";
    const signature = signTestWalletWebhookBody(body, SECRET);

    const result = await ingestWalletWebhookEvent(organization.id, body, signature, provider);
    expect(result.outcome).toBe("rejected");
  });

  it("rejects a transaction whose destination address is not a wallet connected to this organization", async () => {
    const { organization } = await createTestOrganization();
    const body = serializeTestWalletEvent(baseEvent({ toAddress: "0xnobody" }));
    const signature = signTestWalletWebhookBody(body, SECRET);

    const result = await ingestWalletWebhookEvent(organization.id, body, signature, provider);

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") expect(result.reason).toBe("unknown_wallet");
    const events = await prisma.activityEvent.findMany({ where: { organizationId: organization.id } });
    expect(events.some((e) => e.type === "WALLET_WEBHOOK_REJECTED")).toBe(true);
  });

  it("tenant isolation: a webhook delivered against org A never resolves org B's wallet, even with the correct address", async () => {
    const { organization: orgA } = await createTestOrganization("A");
    const { organization: orgB } = await createTestOrganization("B");
    const walletB = await createActiveTestWallet(orgB.id, { address: "0xshared" });
    const body = serializeTestWalletEvent(baseEvent({ toAddress: walletB.address }));
    const signature = signTestWalletWebhookBody(body, SECRET);

    const result = await ingestWalletWebhookEvent(orgA.id, body, signature, provider);

    expect(result.outcome).toBe("rejected");
    const orgATransactions = await prisma.walletTransaction.findMany({ where: { organizationId: orgA.id } });
    expect(orgATransactions).toHaveLength(0);
  });
});

describe("ingestWalletWebhookEvent — ingestion + idempotency", () => {
  it("creates a new WalletTransaction and records WALLET_TRANSACTION_DETECTED", async () => {
    const { organization } = await createTestOrganization();
    const wallet = await createActiveTestWallet(organization.id, { address: "0xmerchant" });
    const body = serializeTestWalletEvent(baseEvent({ toAddress: wallet.address }));
    const signature = signTestWalletWebhookBody(body, SECRET);

    const result = await ingestWalletWebhookEvent(organization.id, body, signature, provider);

    expect(result.outcome).toBe("ingested");
    if (result.outcome === "ingested") {
      expect(result.isNewTransaction).toBe(true);
      expect(result.transaction.status).toBe("DETECTED");
      expect(result.transaction.reconciliationOutcome).toBeNull();
    }
    const events = await prisma.activityEvent.findMany({ where: { organizationId: organization.id } });
    expect(events.some((e) => e.type === "WALLET_TRANSACTION_DETECTED")).toBe(true);
  });

  it("the same (network, txHash) delivered twice never creates a second row", async () => {
    const { organization } = await createTestOrganization();
    const wallet = await createActiveTestWallet(organization.id, { address: "0xmerchant" });
    const event = baseEvent({ toAddress: wallet.address });
    const body = serializeTestWalletEvent(event);
    const signature = signTestWalletWebhookBody(body, SECRET);

    await ingestWalletWebhookEvent(organization.id, body, signature, provider);
    await ingestWalletWebhookEvent(organization.id, body, signature, provider);

    const rows = await prisma.walletTransaction.findMany({
      where: { organizationId: organization.id, network: event.network, txHash: event.txHash },
    });
    expect(rows).toHaveLength(1);
  });

  it("advances DETECTED -> CONFIRMING -> CONFIRMED across separate deliveries for the same transaction, firing WALLET_TRANSACTION_CONFIRMED exactly once", async () => {
    const { organization } = await createTestOrganization();
    const wallet = await createActiveTestWallet(organization.id, { address: "0xmerchant" });
    const txHash = "0xsame-tx";

    const detected = serializeTestWalletEvent(baseEvent({ toAddress: wallet.address, txHash, status: "DETECTED" }));
    await ingestWalletWebhookEvent(organization.id, detected, signTestWalletWebhookBody(detected, SECRET), provider);

    const confirming = serializeTestWalletEvent(
      baseEvent({ toAddress: wallet.address, txHash, status: "CONFIRMING", confirmations: 1 }),
    );
    await ingestWalletWebhookEvent(organization.id, confirming, signTestWalletWebhookBody(confirming, SECRET), provider);

    const confirmed = serializeTestWalletEvent(
      baseEvent({ toAddress: wallet.address, txHash, status: "CONFIRMED", confirmations: 3 }),
    );
    const finalResult = await ingestWalletWebhookEvent(
      organization.id,
      confirmed,
      signTestWalletWebhookBody(confirmed, SECRET),
      provider,
    );

    expect(finalResult.outcome).toBe("ingested");
    if (finalResult.outcome === "ingested") expect(finalResult.transaction.status).toBe("CONFIRMED");

    const confirmedEvents = await prisma.activityEvent.findMany({
      where: { organizationId: organization.id, type: "WALLET_TRANSACTION_CONFIRMED" },
    });
    expect(confirmedEvents).toHaveLength(1);
  });

  it("ignores a late/out-of-order delivery reporting an earlier status than the transaction's current (terminal) status", async () => {
    const { organization } = await createTestOrganization();
    const wallet = await createActiveTestWallet(organization.id, { address: "0xmerchant" });
    const txHash = "0xterminal-tx";

    const confirmed = serializeTestWalletEvent(
      baseEvent({ toAddress: wallet.address, txHash, status: "CONFIRMED", confirmations: 3 }),
    );
    await ingestWalletWebhookEvent(organization.id, confirmed, signTestWalletWebhookBody(confirmed, SECRET), provider);

    const staleDetected = serializeTestWalletEvent(
      baseEvent({ toAddress: wallet.address, txHash, status: "DETECTED", confirmations: 0 }),
    );
    const result = await ingestWalletWebhookEvent(
      organization.id,
      staleDetected,
      signTestWalletWebhookBody(staleDetected, SECRET),
      provider,
    );

    expect(result.outcome).toBe("ignored_stale_replay");
    const row = await prisma.walletTransaction.findFirstOrThrow({
      where: { organizationId: organization.id, txHash },
    });
    expect(row.status).toBe("CONFIRMED"); // never overwritten backward
  });

  it("auto-triggers reconciliation on reaching CONFIRMED — an incoming CONFIRMED transaction with no open payment request is rejected, not left unprocessed", async () => {
    const { organization } = await createTestOrganization();
    const wallet = await createActiveTestWallet(organization.id, { address: "0xmerchant" });
    const body = serializeTestWalletEvent(
      baseEvent({ toAddress: wallet.address, status: "CONFIRMED", confirmations: 3 }),
    );
    const signature = signTestWalletWebhookBody(body, SECRET);

    const result = await ingestWalletWebhookEvent(organization.id, body, signature, provider);

    expect(result.outcome).toBe("ingested");
    if (result.outcome === "ingested") {
      expect(result.transaction.reconciliationOutcome).toBe("REJECTED");
      expect(result.transaction.reconciliationRejectionReason).toBe("NO_OPEN_PAYMENT_REQUEST");
    }
  });

  it("never reconciles an OUTGOING transaction even once CONFIRMED", async () => {
    const { organization } = await createTestOrganization();
    const wallet = await createActiveTestWallet(organization.id, { address: "0xmerchant" });
    const body = serializeTestWalletEvent(
      baseEvent({ toAddress: wallet.address, direction: "OUTGOING", status: "CONFIRMED", confirmations: 3 }),
    );
    const signature = signTestWalletWebhookBody(body, SECRET);

    const result = await ingestWalletWebhookEvent(organization.id, body, signature, provider);

    expect(result.outcome).toBe("ingested");
    if (result.outcome === "ingested") expect(result.transaction.reconciliationOutcome).toBeNull();
  });
});
