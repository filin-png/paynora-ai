import { z } from "zod";

import { prisma } from "@/server/db/client";
import { recordActivityEvent } from "./activity";
import { ArResourceNotFoundError } from "./errors";

export const customerInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: z
    .string()
    .trim()
    .email("Enter a valid email address")
    .optional()
    .or(z.literal(""))
    .transform((value) => (value ? value : undefined)),
  phone: z
    .string()
    .trim()
    .max(50)
    .optional()
    .transform((value) => (value ? value : undefined)),
  companyName: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => (value ? value : undefined)),
  notes: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((value) => (value ? value : undefined)),
});

export type CustomerInput = z.input<typeof customerInputSchema>;

export async function createCustomer(organizationId: string, rawInput: CustomerInput) {
  const input = customerInputSchema.parse(rawInput);

  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.create({
      data: { organizationId, ...input },
    });
    await recordActivityEvent(tx, {
      organizationId,
      type: "CUSTOMER_CREATED",
      summary: `Customer "${customer.name}" created`,
      customerId: customer.id,
    });
    return customer;
  });
}

export async function getCustomer(organizationId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, organizationId },
  });
  if (!customer) throw new ArResourceNotFoundError("Customer");
  return customer;
}

export async function listCustomers(
  organizationId: string,
  options: { includeArchived?: boolean } = {},
) {
  return prisma.customer.findMany({
    where: {
      organizationId,
      ...(options.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: { name: "asc" },
  });
}

export async function updateCustomer(
  organizationId: string,
  customerId: string,
  rawInput: CustomerInput,
) {
  const input = customerInputSchema.parse(rawInput);
  await getCustomer(organizationId, customerId); // tenant-scoped existence check

  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.update({
      where: { id: customerId },
      data: input,
    });
    await recordActivityEvent(tx, {
      organizationId,
      type: "CUSTOMER_UPDATED",
      summary: `Customer "${customer.name}" updated`,
      customerId: customer.id,
    });
    return customer;
  });
}

export async function archiveCustomer(organizationId: string, customerId: string) {
  const customer = await getCustomer(organizationId, customerId);
  if (customer.archivedAt) return customer; // already archived — idempotent, no duplicate event

  return prisma.$transaction(async (tx) => {
    const archived = await tx.customer.update({
      where: { id: customerId },
      data: { archivedAt: new Date() },
    });
    await recordActivityEvent(tx, {
      organizationId,
      type: "CUSTOMER_ARCHIVED",
      summary: `Customer "${archived.name}" archived`,
      customerId: archived.id,
    });
    return archived;
  });
}
