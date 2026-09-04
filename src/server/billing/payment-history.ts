import { prisma } from "@/server/db/client";

export type OrganizationSubscriptionPayment = {
  id: string;
  provider: string;
  status: string;
  amountMinor: bigint | null;
  currency: string | null;
  receivedAt: Date;
};

/**
 * Organization-scoped read of PAYNORA's own subscription-payment ledger
 * (Phase 18's `SubscriptionPayment` — see webhook-events.ts) for the
 * Billing UI (Settings -> Billing). Deliberately distinct from
 * `scripts/subscription-report.ts`'s founder-only, all-organizations CLI:
 * this is what one organization's own members are allowed to see about
 * their own PAYNORA subscription, scoped by `organizationId` the same way
 * every other tenant-scoped read in this codebase is — never a second
 * query path that could leak another organization's payment history.
 *
 * This is PAYNORA's own subscription-payment history — never to be
 * confused with, or merged into, an organization's *own* customer
 * invoice/payment data (src/server/ar/payments.ts). See
 * docs/commercial-product-architecture.md#billing-domain-separation.
 */
export async function getOrganizationSubscriptionPayments(
  organizationId: string,
  limit = 20,
): Promise<OrganizationSubscriptionPayment[]> {
  const rows = await prisma.subscriptionPayment.findMany({
    where: { organizationId },
    orderBy: { receivedAt: "desc" },
    take: limit,
    select: { id: true, provider: true, status: true, amountMinor: true, currency: true, receivedAt: true },
  });
  return rows;
}
