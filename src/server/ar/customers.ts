import { z } from "zod";

import { prisma } from "@/server/db/client";
import { normalizeEmail } from "@/server/auth/email";
import { assertWithinResourceLimit } from "@/server/billing/entitlements";
import { recordActivityEvent } from "./activity";
import { ArResourceNotFoundError } from "./errors";

export const customerInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  // Normalized (trimmed + lowercased) the same way User.email is
  // (src/server/auth/email.ts) — a customer's reminder emails go to this
  // address (see docs/communications.md), so it goes through the same
  // validation/normalization discipline as a login email, not just a
  // free-text contact field.
  email: z
    .string()
    .trim()
    .email("Enter a valid email address")
    .optional()
    .or(z.literal(""))
    .transform((value) => (value ? normalizeEmail(value) : undefined)),
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
  // Phase 8: Telegram destination — see docs/communications.md#channel-model.
  // A numeric chat id or "@channelusername"; free-form since Telegram's own
  // id space isn't a fixed pattern this codebase should second-guess.
  telegramChatId: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((value) => (value ? value : undefined)),
  // Explicit only — never inferred. Empty string means "no preference set",
  // not "EMAIL" — see resolveCommunicationDestination for what that means.
  preferredCommunicationChannel: z
    .enum(["EMAIL", "TELEGRAM"])
    .optional()
    .or(z.literal(""))
    .transform((value) => (value ? value : undefined)),
});

export type CustomerInput = z.input<typeof customerInputSchema>;

export async function createCustomer(organizationId: string, rawInput: CustomerInput) {
  const input = customerInputSchema.parse(rawInput);

  return prisma.$transaction(async (tx) => {
    await assertWithinResourceLimit(tx, organizationId, "customers");

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

/**
 * Applied whenever a caller doesn't explicitly request a page size —
 * bounds worst-case query cost for callers that don't paginate (e.g. the
 * invoice-form customer picker) without changing their return shape. See
 * docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-6. The customers list
 * page passes its own `take`/`cursor` for real pagination.
 */
const CUSTOMER_LIST_DEFAULT_TAKE = 100;

export async function listCustomers(
  organizationId: string,
  options: { includeArchived?: boolean; cursor?: string; take?: number } = {},
) {
  return prisma.customer.findMany({
    where: {
      organizationId,
      ...(options.includeArchived ? {} : { archivedAt: null }),
    },
    // `id` is a stable tiebreak for `name` (not unique on its own) — required
    // for cursor pagination to never skip or repeat a row when two customers
    // share a name.
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: options.take ?? CUSTOMER_LIST_DEFAULT_TAKE,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
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
