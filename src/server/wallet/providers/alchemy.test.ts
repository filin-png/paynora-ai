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

  const ADDR = "0xba604dd4a9ba94f5752d7f313e66c582c15e682e"; // a syntactically valid, arbitrary EVM address

  it("getBalances merges the native asset balance alongside ERC-20 token balances", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(init.body as string) as { method: string };
      if (parsed.method === "eth_getBalance") {
        return { ok: true, json: async () => ({ result: "0xde0b6b3a7640000" }) }; // 1 ETH in wei
      }
      return {
        ok: true,
        json: async () => ({
          result: {
            tokenBalances: [
              { contractAddress: "0xtoken1", tokenBalance: "0x64" },
              { contractAddress: "0xtoken2", tokenBalance: "0x0" }, // zero balance, must be filtered out
            ],
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createAlchemyWalletProvider(CONFIG);
    const balances = await provider.getBalances("ETHEREUM", ADDR);

    expect(balances).toEqual([
      { assetType: "native", asset: "ETH", assetDecimals: 18, amountMinor: 1000000000000000000n, chain: "ETHEREUM" },
      { assetType: "token", asset: "0xtoken1", assetDecimals: 18, amountMinor: 100n, chain: "ETHEREUM" },
    ]);
  });

  it("getBalances handles a very large wei amount without precision loss (exceeds Number.MAX_SAFE_INTEGER)", async () => {
    // 1,000,000 ETH in wei — well beyond Number.MAX_SAFE_INTEGER (~9.007e15), which real wei
    // amounts exceed at well under 1 ETH. Asserting a bigint equality here is itself the
    // precision-loss guard: BigInt(hex) never rounds, unlike a Number conversion would.
    const largeWei = 1_000_000n * 10n ** 18n;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(init.body as string) as { method: string };
      if (parsed.method === "eth_getBalance") {
        return { ok: true, json: async () => ({ result: `0x${largeWei.toString(16)}` }) };
      }
      return { ok: true, json: async () => ({ result: { tokenBalances: [] } }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createAlchemyWalletProvider(CONFIG);
    const balances = await provider.getBalances("ETHEREUM", ADDR);

    expect(balances[0]!.amountMinor).toBe(largeWei);
    expect(largeWei > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("getBalances omits the native asset entry when the balance is zero", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(init.body as string) as { method: string };
      if (parsed.method === "eth_getBalance") {
        return { ok: true, json: async () => ({ result: "0x0" }) };
      }
      return { ok: true, json: async () => ({ result: { tokenBalances: [] } }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createAlchemyWalletProvider(CONFIG);
    const balances = await provider.getBalances("ETHEREUM", ADDR);

    expect(balances).toEqual([]);
  });

  it("getBalances uses the network's own native asset symbol (MATIC on Polygon)", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(init.body as string) as { method: string };
      if (parsed.method === "eth_getBalance") {
        return { ok: true, json: async () => ({ result: "0x1" }) };
      }
      return { ok: true, json: async () => ({ result: { tokenBalances: [] } }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createAlchemyWalletProvider(CONFIG);
    const balances = await provider.getBalances("POLYGON", ADDR);

    expect(balances).toEqual([{ assetType: "native", asset: "MATIC", assetDecimals: 18, amountMinor: 1n, chain: "POLYGON" }]);
  });

  it("getBalances rejects an unsupported network before making any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = createAlchemyWalletProvider(CONFIG);

    await expect(provider.getBalances("BITCOIN", ADDR)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("getBalances rejects a malformed address before making any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = createAlchemyWalletProvider(CONFIG);

    await expect(provider.getBalances("ETHEREUM", "not-an-address")).rejects.toThrow(/valid EVM address/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("getBalances rejects when the underlying request errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Internal Server Error" });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createAlchemyWalletProvider(CONFIG);

    await expect(provider.getBalances("ETHEREUM", ADDR)).rejects.toThrow();
  });

  it("getBalances rejects when the request times out", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createAlchemyWalletProvider(CONFIG);

    const assertion = expect(provider.getBalances("ETHEREUM", ADDR)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    vi.useRealTimers();
  });
});
