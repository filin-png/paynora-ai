import { createHmac } from "node:crypto";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WalletWebhookVerificationError } from "../errors";
import { createAlchemyWalletProvider } from "./alchemy";

const CONFIG = {
  apiKey: "test-api-key",
  authToken: "test-auth-token",
  webhookId: "wh_test",
  webhookSigningKey: "test-signing-key",
};

/**
 * Signs an EIP-191 personal_sign message with a fresh keypair, for testing
 * recovery independently of any live wallet. Noble's "recovered" signature
 * format is (v, r, s) — v first; real wallets (MetaMask/ethers/viem's
 * personal_sign) return (r, s, v) — v last. This reorders to match what a
 * real client actually sends, which is the format
 * src/server/wallet/providers/alchemy.ts#recoverEip191Address parses.
 */
function signPersonalMessage(message: string, secretKey: Uint8Array) {
  const prefixed = `\x19Ethereum Signed Message:\n${message.length}${message}`;
  const digest = keccak_256(new TextEncoder().encode(prefixed));
  const sig = secp256k1.sign(digest, secretKey, { prehash: false, format: "recovered" });
  const v = sig[0]!;
  const r = sig.slice(1, 33);
  const s = sig.slice(33, 65);
  const hex = Buffer.from([...r, ...s, v]).toString("hex");
  return `0x${hex}`;
}

function addressFromSecretKey(secretKey: Uint8Array): string {
  const publicKey = secp256k1.getPublicKey(secretKey, false).slice(1);
  const addressBytes = keccak_256(publicKey).slice(-20);
  return `0x${Buffer.from(addressBytes).toString("hex")}`;
}

describe("createAlchemyWalletProvider — verifyOwnership (real EIP-191 recovery)", () => {
  it("verifies a real signature against the address that actually signed it", async () => {
    const secretKey = secp256k1.utils.randomSecretKey();
    const address = addressFromSecretKey(secretKey);
    const message = "PAYNORA wallet ownership proof: org_123";
    const signature = signPersonalMessage(message, secretKey);

    const provider = createAlchemyWalletProvider(CONFIG);
    const result = await provider.verifyOwnership("ETHEREUM", address, { message, signature });

    expect(result.verified).toBe(true);
  });

  it("rejects a signature that recovers to a different address", async () => {
    const secretKey = secp256k1.utils.randomSecretKey();
    const message = "PAYNORA wallet ownership proof: org_123";
    const signature = signPersonalMessage(message, secretKey);

    const provider = createAlchemyWalletProvider(CONFIG);
    const result = await provider.verifyOwnership("ETHEREUM", "0x0000000000000000000000000000000000dead", {
      message,
      signature,
    });

    expect(result.verified).toBe(false);
  });

  it("rejects a malformed proof without throwing", async () => {
    const provider = createAlchemyWalletProvider(CONFIG);
    const result = await provider.verifyOwnership("ETHEREUM", "0xabc", { message: "x" });
    expect(result.verified).toBe(false);
  });
});

describe("createAlchemyWalletProvider — webhook verification", () => {
  it("verifies a webhook signed with the configured signing key", () => {
    const provider = createAlchemyWalletProvider(CONFIG);
    const body = JSON.stringify({
      id: "evt_1",
      createdAt: "2026-01-01T00:00:00Z",
      event: {
        network: "ETH_MAINNET",
        activity: [{ hash: "0xhash", fromAddress: "0xfrom", toAddress: "0xto", asset: "ETH" }],
      },
    });
    const signature = createHmac("sha256", CONFIG.webhookSigningKey).update(body, "utf8").digest("hex");

    const event = provider.verifyAndParseWebhookEvent(body, signature);
    expect(event.txHash).toBe("0xhash");
    expect(event.network).toBe("ETHEREUM");
  });

  it("throws on an invalid signature", () => {
    const provider = createAlchemyWalletProvider(CONFIG);
    expect(() => provider.verifyAndParseWebhookEvent("{}", "wrong")).toThrow(WalletWebhookVerificationError);
  });

  it("throws on a malformed payload even with a technically-valid signature over garbage", () => {
    const provider = createAlchemyWalletProvider(CONFIG);
    const body = "not json";
    const signature = createHmac("sha256", CONFIG.webhookSigningKey).update(body, "utf8").digest("hex");
    expect(() => provider.verifyAndParseWebhookEvent(body, signature)).toThrow(WalletWebhookVerificationError);
  });
});

describe("createAlchemyWalletProvider — network calls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("connectWallet PATCHes the Notify API with the auth token and address", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createAlchemyWalletProvider(CONFIG);
    await provider.connectWallet({ network: "ETHEREUM", address: "0xabc" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://dashboard.alchemy.com/api/update-webhook-addresses");
    expect((init.headers as Record<string, string>)["X-Alchemy-Token"]).toBe(CONFIG.authToken);
  });

  it("rejects an unsupported network before making any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = createAlchemyWalletProvider(CONFIG);

    await expect(provider.connectWallet({ network: "BITCOIN", address: "0xabc" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
