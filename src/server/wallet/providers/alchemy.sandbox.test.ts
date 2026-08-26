/**
 * Sandbox integration test — makes a REAL JSON-RPC call to a REAL Alchemy
 * endpoint using a REAL API key. Deliberately separate from alchemy.test.ts
 * (mocked `fetch` + a real cryptographic self-test, always runs, no
 * credentials needed).
 *
 * Opt-in only: skipped unless RUN_EXTERNAL_INTEGRATION_TESTS=true, so
 * `npm run test` and CI never require an Alchemy account. Read-only —
 * looks up balances for the zero address (0x000...000), never a specific
 * person's or organization's wallet, so this never targets or reveals
 * anything about a real PAYNORA customer or third party. To run it
 * locally against your own Alchemy app (a free-tier app is enough — this
 * only reads):
 *
 *   RUN_EXTERNAL_INTEGRATION_TESTS=true ALCHEMY_API_KEY=xxx npm run test -- alchemy.sandbox
 *
 * See docs/production-integrations.md#test-layers.
 */
import { describe, expect, it } from "vitest";

import { createAlchemyWalletProvider } from "./alchemy";

const RUN = process.env.RUN_EXTERNAL_INTEGRATION_TESTS === "true";
const apiKey = process.env.ALCHEMY_API_KEY;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

describe.skipIf(!RUN)("Alchemy sandbox (real network, opt-in)", () => {
  it("authenticates and reads real token balances for a known address", async () => {
    if (!apiKey) {
      throw new Error("ALCHEMY_API_KEY must be set when RUN_EXTERNAL_INTEGRATION_TESTS=true for this test to run.");
    }

    // Only the read-only apiKey is required for this call — the other
    // three Alchemy credentials (auth token, webhook id, webhook signing
    // key) are only used by connectWallet/verifyAndParseWebhookEvent,
    // which this read-only sandbox test deliberately does not exercise.
    const provider = createAlchemyWalletProvider({
      apiKey,
      authToken: "unused-in-this-test",
      webhookId: "unused-in-this-test",
      webhookSigningKey: "unused-in-this-test",
    });

    const balances = await provider.getBalances("ETHEREUM", ZERO_ADDRESS);
    expect(Array.isArray(balances)).toBe(true);
  });
});
