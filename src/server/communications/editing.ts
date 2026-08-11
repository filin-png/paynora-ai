import { z } from "zod";
import type { Communication } from "@prisma/client";

import { recordActivityEvent } from "@/server/ar/activity";
import { prisma } from "@/server/db/client";
import { CommunicationResourceNotFoundError, InvalidCommunicationTransitionError } from "./errors";
import { MAX_BODY_LENGTH, MAX_SUBJECT_LENGTH } from "./templates";

export const communicationEditSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(1, "Subject is required")
    .max(MAX_SUBJECT_LENGTH, `Subject must be ${MAX_SUBJECT_LENGTH} characters or fewer`)
    // Subject becomes an email header; a raw CR/LF would let a crafted
    // subject inject additional headers (Bcc, a forged From, ...) — see
    // docs/communications.md#email-security.
    .refine((value) => !/[\r\n]/.test(value), "Subject cannot contain line breaks"),
  body: z
    .string()
    .trim()
    .min(1, "Body is required")
    .max(MAX_BODY_LENGTH, `Body must be ${MAX_BODY_LENGTH} characters or fewer`),
});

export type CommunicationEditInput = z.input<typeof communicationEditSchema>;

/**
 * Only allowed while the communication is still DRAFT — enforced as an
 * atomic conditional update (`WHERE status = 'DRAFT'`), not a separate
 * read-then-write, so a concurrent Send that has already claimed the row
 * (DRAFT -> SENDING) can never be silently overwritten by a stale edit
 * that read the old DRAFT state before the claim committed. Same
 * technique as src/server/operator/approval.ts's compare-and-swap fix —
 * see docs/communications.md#concurrency and
 * src/server/communications/editing.test.ts for the concurrent
 * edit-vs-send test.
 */
export async function updateCommunicationDraft(
  organizationId: string,
  communicationId: string,
  rawInput: CommunicationEditInput,
): Promise<Communication> {
  const input = communicationEditSchema.parse(rawInput);

  return prisma.$transaction(async (tx) => {
    const result = await tx.communication.updateMany({
      where: { id: communicationId, organizationId, status: "DRAFT" },
      data: { subject: input.subject, body: input.body },
    });

    if (result.count === 1) {
      const updated = await tx.communication.findUniqueOrThrow({ where: { id: communicationId } });
      await recordActivityEvent(tx, {
        organizationId,
        type: "COMMUNICATION_EDITED",
        summary: `Payment reminder email edited for invoice ${updated.invoiceId}`,
        customerId: updated.customerId,
        invoiceId: updated.invoiceId,
      });
      return updated;
    }

    const current = await tx.communication.findFirst({ where: { id: communicationId, organizationId } });
    if (!current) throw new CommunicationResourceNotFoundError("Communication");
    throw new InvalidCommunicationTransitionError(
      current.status,
      "cannot edit a communication once sending has started",
    );
  });
}
