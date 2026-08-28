import { createHmac, timingSafeEqual } from "node:crypto";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

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

const REQUEST_TIMEOUT_MS = 10_000;
const DASHBOARD_BASE = "https://dashboard.alchemy.com/api";

/**
 * Maps PAYNORA's network allowlist to Alchemy's network identifiers.
 * Alchemy does not support every network in src/server/wallet/network.ts
 * (BITCOIN/TRON/SOLANA are not EVM chains, or use a different Alchemy
 * product) — see docs/production-integrations.md#wallet for exactly which
 * networks this adapter actually supports today.
 */
const ALCHEMY_NETWORK_SLUG: Partial<Record<WalletNetwork, string>> = {
  ETHEREUM: "eth-mainnet",
  POLYGON: "polygon-mainnet",
  BSC: "bnb-mainnet",
};

/** Each EVM chain's own native (gas) asset — never returned by `alchemy_getTokenBalances`, which only covers ERC-20 tokens; see `getBalances` below. */
const NATIVE_ASSET_SYMBOL: Partial<Record<WalletNetwork, string>> = {
  ETHEREUM: "ETH",
  POLYGON: "MATIC",
  BSC: "BNB",
};

function requireNetworkSlug(network: WalletNetwork): string {
  const slug = ALCHEMY_NETWORK_SLUG[network];
  if (!slug) {
    throw new Error(
      `Alchemy adapter does not support network "${network}" yet — see docs/production-integrations.md#wallet`,
    );
  }
  return slug;
}

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** Every network this adapter supports is EVM-based — a single shared shape check, not one that would generalize to BITCOIN/TRON/SOLANA if this adapter ever grew to cover them. */
function requireEvmAddress(address: string): void {
  if (!EVM_ADDRESS_PATTERN.test(address)) {
    throw new Error(`"${address}" is not a valid EVM address (expected 0x followed by 40 hex characters)`);
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Alchemy request failed: ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Real adapter for Alchemy — a non-custodial address-monitoring provider
 * (Alchemy never holds a private key on PAYNORA's behalf; PAYNORA only
 * ever asks it to watch an address and report activity). See
 * docs/production-integrations.md#wallet for the full setup, pricing, and
 * the exact fields verified against Alchemy's official documentation vs.
 * general knowledge of their stable, long-standing webhook schema (the
 * one part not independently re-verified against live docs in this
 * phase — see that doc's "confidence" note).
 *
 * Three distinct credentials, three distinct Alchemy surfaces:
 * - `apiKey` — JSON-RPC / Enhanced API calls (inspectTransaction, getBalances).
 * - `authToken` — the Notify (webhook-management) API (connectWallet).
 * - `webhookSigningKey` — verifying inbound webhook deliveries.
 */
export function createAlchemyWalletProvider(config: {
  apiKey: string;
  authToken: string;
  webhookId: string;
  webhookSigningKey: string;
}): WalletProvider {
  return {
    name: "alchemy",

    async connectWallet(request: WalletConnectionRequest): Promise<WalletConnectionResult> {
      requireNetworkSlug(request.network);
      await fetchJson(`${DASHBOARD_BASE}/update-webhook-addresses`, {
        method: "PATCH",
        headers: { "X-Alchemy-Token": config.authToken, "content-type": "application/json" },
        body: JSON.stringify({
          webhook_id: config.webhookId,
          addresses_to_add: [request.address],
          addresses_to_remove: [],
        }),
      });
      return { providerWalletId: `${config.webhookId}:${request.address}` };
    },

    async verifyOwnership(
      _network: WalletNetwork,
      address: string,
      proof: unknown,
    ): Promise<WalletOwnershipVerification> {
      // EIP-191 personal_sign verification: `proof` must be
      // { message: string; signature: string (0x-prefixed 65-byte hex) }.
      // Recovers the signer's address from the signature and compares it
      // to the wallet's claimed address — never trusts the claim alone.
      const parsed = proof as { message?: unknown; signature?: unknown } | null;
      if (!parsed || typeof parsed.message !== "string" || typeof parsed.signature !== "string") {
        return { verified: false, reason: "Missing signed message/signature proof" };
      }
      try {
        const recovered = recoverEip191Address(parsed.message, parsed.signature);
        if (recovered.toLowerCase() !== address.toLowerCase()) {
          return { verified: false, reason: "Signature does not match the claimed address" };
        }
        return { verified: true };
      } catch {
        return { verified: false, reason: "Malformed signature" };
      }
    },

    async getBalances(network: WalletNetwork, address: string): Promise<WalletBalance[]> {
      const slug = requireNetworkSlug(network);
      requireEvmAddress(address);
      const rpcUrl = `https://${slug}.g.alchemy.com/v2/${config.apiKey}`;

      // Two separate JSON-RPC methods: `alchemy_getTokenBalances` only
      // covers ERC-20 tokens, never the chain's own native (gas) asset —
      // that requires the standard `eth_getBalance` call instead. Both
      // requested in parallel; a real wallet's balance is meaningless
      // without its native balance alongside any token balances.
      const [tokenBody, nativeBody] = await Promise.all([
        fetchJson(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getTokenBalances", params: [address] }),
        }),
        fetchJson(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getBalance", params: [address, "latest"] }),
        }),
      ]);

      const balances: WalletBalance[] = [];

      const nativeHex = (nativeBody as { result?: string }).result;
      const nativeAsset = NATIVE_ASSET_SYMBOL[network];
      if (nativeHex && nativeAsset) {
        const amountMinor = BigInt(nativeHex);
        if (amountMinor > 0n) {
          balances.push({ assetType: "native", asset: nativeAsset, assetDecimals: 18, amountMinor, chain: network });
        }
      }

      const tokenBalances = (tokenBody as { result?: { tokenBalances?: { contractAddress: string; tokenBalance: string }[] } })
        .result?.tokenBalances;
      if (tokenBalances) {
        for (const entry of tokenBalances) {
          if (!entry.tokenBalance || entry.tokenBalance === "0x0") continue;
          balances.push({
            assetType: "token",
            asset: entry.contractAddress,
            assetDecimals: 18,
            amountMinor: BigInt(entry.tokenBalance),
            chain: network,
          });
        }
      }

      return balances;
    },

    async inspectTransaction(network: WalletNetwork, txHash: string): Promise<RawWalletEvent | null> {
      const slug = requireNetworkSlug(network);
      const body = (await fetchJson(`https://${slug}.g.alchemy.com/v2/${config.apiKey}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [txHash],
        }),
      })) as { result?: Record<string, unknown> | null };
      const receipt = body.result;
      if (!receipt) return null;
      const confirmed = receipt.status === "0x1";
      return {
        network,
        txHash,
        direction: "INCOMING",
        asset: "ETH",
        assetDecimals: 18,
        amountMinor: 0n, // eth_getTransactionReceipt does not carry value — see docs/production-integrations.md#wallet known limitations.
        toAddress: (receipt.to as string) ?? "",
        fromAddress: receipt.from as string | undefined,
        status: confirmed ? "CONFIRMED" : "FAILED",
        confirmations: confirmed ? 1 : 0,
        requiredConfirmations: 1,
        observedAt: new Date(),
      };
    },

    verifyAndParseWebhookEvent(rawBody: string, signatureHeader: string): RawWalletEvent {
      const expected = createHmac("sha256", config.webhookSigningKey).update(rawBody, "utf8").digest("hex");
      if (!signatureHeader || !safeEqual(signatureHeader, expected)) {
        throw new WalletWebhookVerificationError("alchemy");
      }
      let payload: AlchemyAddressActivityPayload;
      try {
        payload = JSON.parse(rawBody) as AlchemyAddressActivityPayload;
      } catch {
        throw new WalletWebhookVerificationError("alchemy");
      }
      const activity = payload.event?.activity?.[0];
      if (!activity) throw new WalletWebhookVerificationError("alchemy");
      return {
        providerEventId: payload.id,
        network: alchemyNetworkToWalletNetwork(payload.event.network),
        txHash: activity.hash,
        direction: "INCOMING",
        asset: activity.asset ?? "ETH",
        assetDecimals: activity.rawContract?.decimals ?? 18,
        amountMinor: activity.rawContract?.rawValue ? BigInt(activity.rawContract.rawValue) : 0n,
        fromAddress: activity.fromAddress,
        toAddress: activity.toAddress,
        status: "DETECTED",
        confirmations: 0,
        requiredConfirmations: 1,
        observedAt: new Date(payload.createdAt ?? Date.now()),
      };
    },
  };
}

type AlchemyAddressActivityPayload = {
  id?: string;
  createdAt?: string;
  event: {
    network: string;
    activity: {
      hash: string;
      fromAddress: string;
      toAddress: string;
      asset?: string;
      rawContract?: { rawValue?: string; decimals?: number };
    }[];
  };
};

function alchemyNetworkToWalletNetwork(alchemyNetwork: string): WalletNetwork {
  const entry = Object.entries(ALCHEMY_NETWORK_SLUG).find(
    ([, slug]) => slug?.toUpperCase().replace("-MAINNET", "") === alchemyNetwork.toUpperCase().replace("_MAINNET", ""),
  );
  if (!entry) throw new Error(`Unrecognized Alchemy network "${alchemyNetwork}"`);
  return entry[0] as WalletNetwork;
}

/** EIP-191 ("personal_sign") signature recovery — throws on a malformed signature. */
function recoverEip191Address(message: string, signatureHex: string): string {
  const sig = signatureHex.startsWith("0x") ? signatureHex.slice(2) : signatureHex;
  if (sig.length !== 130) throw new Error("Signature must be 65 bytes (r + s + v)");
  const r = sig.slice(0, 64);
  const s = sig.slice(64, 128);
  let v = parseInt(sig.slice(128, 130), 16);
  if (v >= 27) v -= 27;

  const prefixed = `\x19Ethereum Signed Message:\n${message.length}${message}`;
  const digest = keccak_256(new TextEncoder().encode(prefixed));

  const signature = new secp256k1.Signature(BigInt(`0x${r}`), BigInt(`0x${s}`), v);
  const publicKey = signature.recoverPublicKey(digest).toBytes(false).slice(1); // drop the 0x04 prefix
  const addressBytes = keccak_256(publicKey).slice(-20);
  return `0x${Buffer.from(addressBytes).toString("hex")}`;
}
