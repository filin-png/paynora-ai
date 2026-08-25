import { createHmac, timingSafeEqual } from "node:crypto";

import { WalletWebhookVerificationError } from "../errors";
import type { WalletNetwork } from "../network";
import type {
  RawWalletEvent,
  WalletBalance,
  WalletConnectionRequest,
  WalletConnectionResult,
  WalletOwnershipVerification,
  WalletProvider,
} from "../provider-types";

export const TEST_WALLET_PROVIDER_NAME = "test";
const DEFAULT_TEST_WEBHOOK_SECRET = "test-wallet-webhook-secret";

/** Constant-time compare — same technique as src/server/collections/scheduler-auth.ts's safeEqual. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * JSON.stringify does not support `bigint`/`Date` natively — this is the
 * one place a `RawWalletEvent` fixture is turned into the "raw body" a
 * webhook route would actually receive over HTTP, for use with
 * createTestWalletProvider in tests. Mirrors the money module's own
 * discipline of never letting a `bigint` cross a serialization boundary
 * implicitly.
 */
export function serializeTestWalletEvent(event: RawWalletEvent): string {
  return JSON.stringify({
    ...event,
    amountMinor: event.amountMinor.toString(),
    observedAt: event.observedAt.toISOString(),
  });
}

/** Signs a raw body the same way createTestWalletProvider's verifyAndParseWebhookEvent expects — for constructing valid test webhook deliveries. */
export function signTestWalletWebhookBody(rawBody: string, webhookSecret: string = DEFAULT_TEST_WEBHOOK_SECRET): string {
  return createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
}

export type TestWalletProviderOptions = {
  name?: string;
  webhookSecret?: string;
  ownershipVerified?: boolean;
  ownershipReason?: string;
  balances?: WalletBalance[];
  inspectableTransactions?: RawWalletEvent[];
};

/**
 * Deterministic, in-memory WalletProvider used only by tests — mirrors
 * src/server/ai/providers/fake.ts and src/server/billing/providers/none.ts's
 * "clearly test-only, never reachable from application code" discipline.
 * There is no `WALLET_PROVIDER=test` value (see src/lib/env.ts) — the only
 * way to obtain this provider is a test importing this function directly
 * and passing it as an explicit override, exactly like createFakeProvider.
 *
 * Its webhook signing is a real (if deliberately simple) HMAC-SHA256 over
 * the raw body, not a bypass — this is what lets
 * src/server/wallet/transactions.test.ts genuinely exercise
 * signature-verification failure, malformed payloads, and replay,
 * rather than only ever taking a hard-coded success path.
 */
export function createTestWalletProvider(options: TestWalletProviderOptions = {}): WalletProvider {
  const name = options.name ?? TEST_WALLET_PROVIDER_NAME;
  const webhookSecret = options.webhookSecret ?? DEFAULT_TEST_WEBHOOK_SECRET;

  return {
    name,
    async connectWallet(request: WalletConnectionRequest): Promise<WalletConnectionResult> {
      return { providerWalletId: `test-conn-${request.network}-${request.address}` };
    },
    async verifyOwnership(
      _network: WalletNetwork,
      _address: string,
      _proof: unknown,
    ): Promise<WalletOwnershipVerification> {
      return { verified: options.ownershipVerified ?? true, reason: options.ownershipReason };
    },
    async getBalances(): Promise<WalletBalance[]> {
      return options.balances ?? [];
    },
    async inspectTransaction(network: WalletNetwork, txHash: string): Promise<RawWalletEvent | null> {
      return (
        (options.inspectableTransactions ?? []).find((tx) => tx.network === network && tx.txHash === txHash) ?? null
      );
    },
    verifyAndParseWebhookEvent(rawBody: string, signatureHeader: string): RawWalletEvent {
      const expected = signTestWalletWebhookBody(rawBody, webhookSecret);
      if (!signatureHeader || !safeEqual(signatureHeader, expected)) {
        throw new WalletWebhookVerificationError(name);
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        throw new WalletWebhookVerificationError(name);
      }
      return {
        providerEventId: parsed.providerEventId as string | undefined,
        network: parsed.network as WalletNetwork,
        txHash: parsed.txHash as string,
        direction: parsed.direction as RawWalletEvent["direction"],
        asset: parsed.asset as string,
        assetDecimals: parsed.assetDecimals as number,
        amountMinor: BigInt(parsed.amountMinor as string),
        fromAddress: parsed.fromAddress as string | undefined,
        toAddress: parsed.toAddress as string,
        status: parsed.status as RawWalletEvent["status"],
        confirmations: parsed.confirmations as number,
        requiredConfirmations: parsed.requiredConfirmations as number,
        observedAt: new Date(parsed.observedAt as string),
        metadata: parsed.metadata as Record<string, unknown> | undefined,
      };
    },
  };
}
