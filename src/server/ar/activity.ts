import { Prisma, type ActivityEventType } from "@prisma/client";

import { prisma } from "@/server/db/client";

/**
 * Accepts either the module-level `prisma` client or a `$transaction`
 * callback's `tx` — most activity events are recorded as part of the same
 * transaction as the change they describe (e.g. a payment and its
 * PAYMENT_RECORDED event either both commit or both roll back).
 */
type PrismaClientLike = typeof prisma | Prisma.TransactionClient;

export async function recordActivityEvent(
  client: PrismaClientLike,
  input: {
    organizationId: string;
    type: ActivityEventType;
    summary: string;
    metadata?: Prisma.InputJsonValue;
    customerId?: string;
    invoiceId?: string;
  },
): Promise<void> {
  await client.activityEvent.create({
    data: {
      organizationId: input.organizationId,
      type: input.type,
      summary: input.summary,
      metadata: input.metadata,
      customerId: input.customerId,
      invoiceId: input.invoiceId,
    },
  });
}

const ACTIVITY_PAGE_SIZE = 20;

export async function listOrganizationActivity(organizationId: string, take = ACTIVITY_PAGE_SIZE) {
  return prisma.activityEvent.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    take,
  });
}

/**
 * Bounds a single invoice's/customer's activity timeline the same way
 * `listOrganizationActivity` above already bounds the org-wide one — a
 * long-lived invoice or customer can otherwise accumulate an unbounded
 * number of ActivityEvent rows. See
 * docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-6.
 */
const ENTITY_ACTIVITY_DEFAULT_TAKE = 50;

export async function listInvoiceActivity(
  organizationId: string,
  invoiceId: string,
  options: { cursor?: string; take?: number } = {},
) {
  return prisma.activityEvent.findMany({
    where: { organizationId, invoiceId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.take ?? ENTITY_ACTIVITY_DEFAULT_TAKE,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });
}

export async function listCustomerActivity(
  organizationId: string,
  customerId: string,
  options: { cursor?: string; take?: number } = {},
) {
  return prisma.activityEvent.findMany({
    where: { organizationId, customerId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.take ?? ENTITY_ACTIVITY_DEFAULT_TAKE,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });
}
