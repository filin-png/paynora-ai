import { Prisma, type WalletStatus } from "@prisma/client";
import { z } from "zod";

import { trackEvent } from "@/server/analytics/events";
import { recordActivityEvent } from "@/server/ar/activity";
import { assertWalletEntitled } from "@/server/billing/entitlements";
import { prisma } from "@/server/db/client";
import { DuplicateWalletAddressError, InvalidWalletTransitionError, WalletResourceNotFoundError } from "./errors";
import { walletNetworkSchema, type WalletNetwork } from "./network";
import type { WalletProvider } from "./provider-types";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

export const walletConnectionInputSchema = z.object({
  network: walletNetworkSchema,
  address: z.string().trim().min(1, "Address is required").max(128),
  label: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((value) => (value ? value : undefined)),
});

export type WalletConnectionInput = z.input<typeof walletConnectionInputSchema>;

/**
 * Registers a wallet address as PENDING_VERIFICATION — the address itself
 * is a public identifier, never a credential, so this never asks for or
 * stores a private key or seed phrase (see
 * docs/wallet-architecture.md#security-model). `provider.connectWallet`
 * never itself proves ownership; that is a distinct, explicit step
 * (`verifyWalletOwnership`, below) — see the phase brief's own
 * "connect wallet" vs. "verify wallet ownership" capability split.
 *
 * Phase 19: gated by `assertWalletEntitled` — the organization's plan
 * must have Wallet enabled, checked here in the domain layer so no
 * caller (Server Action, future API route) can bypass it. This is
 * additional to, not instead of, the deployment-level `WALLET_PROVIDER`
 * gate the caller already had to resolve a real `provider` from.
 */
export async function connectWallet(
  organizationId: string,
  rawInput: WalletConnectionInput,
  provider: WalletProvider,
) {
  await assertWalletEntitled(organizationId);
  const input = walletConnectionInputSchema.parse(rawInput);
  const connection = await provider.connectWallet({ network: input.network, address: input.address, label: input.label });

  try {
    return await prisma.wallet.create({
      data: {
        organizationId,
        network: input.network,
        address: input.address,
        label: input.label,
        providerName: provider.name,
        providerWalletId: connection.providerWalletId,
        status: "PENDING_VERIFICATION",
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_CONSTRAINT_VIOLATION) {
      throw new DuplicateWalletAddressError();
    }
    throw error;
  }
}

export type VerifyWalletOwnershipResult =
  | { verified: true; wallet: Awaited<ReturnType<typeof getWallet>> }
  | { verified: false; reason?: string };

/**
 * The one place a Wallet moves PENDING_VERIFICATION -> ACTIVE — gated on
 * `provider.verifyOwnership` actually succeeding. A failed proof is a
 * normal, recoverable outcome (the wallet stays PENDING_VERIFICATION, no
 * activity event, no error thrown) — only a provider/transport failure
 * propagates as an exception. Concurrency-safe via the same compare-and-
 * swap technique used throughout this codebase (e.g.
 * src/server/communications/send.ts's SENDING claim): only one of any
 * number of concurrent verify attempts can win the PENDING_VERIFICATION ->
 * ACTIVE transition.
 */
export async function verifyWalletOwnership(
  organizationId: string,
  walletId: string,
  proof: unknown,
  provider: WalletProvider,
): Promise<VerifyWalletOwnershipResult> {
  const wallet = await getWallet(organizationId, walletId);
  if (wallet.status !== "PENDING_VERIFICATION") {
    throw new InvalidWalletTransitionError(wallet.status, "only a wallet pending verification can be verified");
  }

  const verification = await provider.verifyOwnership(wallet.network as WalletNetwork, wallet.address, proof);
  if (!verification.verified) {
    return { verified: false, reason: verification.reason };
  }

  const result = await prisma.$transaction(async (tx) => {
    const claim = await tx.wallet.updateMany({
      where: { id: walletId, organizationId, status: "PENDING_VERIFICATION" },
      data: { status: "ACTIVE", connectedAt: new Date() },
    });
    if (claim.count !== 1) {
      const current = await tx.wallet.findFirst({ where: { id: walletId, organizationId } });
      if (!current) throw new WalletResourceNotFoundError("Wallet");
      throw new InvalidWalletTransitionError(current.status, "this wallet is no longer pending verification");
    }
    const updated = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
    await recordActivityEvent(tx, {
      organizationId,
      type: "WALLET_CONNECTED",
      summary: `Wallet ${updated.address} connected on ${updated.network}`,
      metadata: { walletId, network: updated.network, providerName: updated.providerName },
    });
    return { verified: true as const, wallet: updated };
  });
  trackEvent("wallet_connected", { organizationId, properties: { network: result.wallet.network, providerName: result.wallet.providerName } });
  return result;
}

/**
 * Terminal — a "reconnected" wallet is created as a new row, not
 * resurrected, so the audit trail of who was connected when is never
 * silently overwritten (see the Wallet model's schema doc comment).
 */
export async function disconnectWallet(organizationId: string, walletId: string) {
  return prisma.$transaction(async (tx) => {
    const claim = await tx.wallet.updateMany({
      where: { id: walletId, organizationId, status: { in: ["PENDING_VERIFICATION", "ACTIVE"] } },
      data: { status: "DISCONNECTED", disconnectedAt: new Date() },
    });
    if (claim.count !== 1) {
      const current = await tx.wallet.findFirst({ where: { id: walletId, organizationId } });
      if (!current) throw new WalletResourceNotFoundError("Wallet");
      throw new InvalidWalletTransitionError(current.status, "this wallet is already disconnected");
    }
    const updated = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
    await recordActivityEvent(tx, {
      organizationId,
      type: "WALLET_DISCONNECTED",
      summary: `Wallet ${updated.address} disconnected`,
      metadata: { walletId, network: updated.network },
    });
    return updated;
  });
}

export async function getWallet(organizationId: string, walletId: string) {
  const wallet = await prisma.wallet.findFirst({ where: { id: walletId, organizationId } });
  if (!wallet) throw new WalletResourceNotFoundError("Wallet");
  return wallet;
}

export async function listWallets(organizationId: string, options: { status?: WalletStatus } = {}) {
  return prisma.wallet.findMany({
    where: { organizationId, ...(options.status ? { status: options.status } : {}) },
    orderBy: { createdAt: "desc" },
  });
}
