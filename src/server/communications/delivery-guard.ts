import type { CommunicationStatus, DeliveryAttemptStatus, DeliveryEvidenceOutcome, DeliveryResolutionDecision, Prisma } from "@prisma/client";

import { CommunicationResourceNotFoundError } from "./errors";

type Evidence = { id: string; outcome: DeliveryEvidenceOutcome; evidenceMetadata?: Prisma.JsonValue };
type Resolution = {
  id: string;
  revision: number;
  supersedesId: string | null;
  decision: DeliveryResolutionDecision;
  evidenceEventId: string | null;
};
type Attempt = {
  status: DeliveryAttemptStatus;
  providerEvents: Evidence[];
  resolutions: Resolution[];
  incidents: { id: string }[];
};
type History = { status: CommunicationStatus; deliveryAttempts: Attempt[] };

export type DeliveryBlock = "frozen" | "invalid_history" | "in_progress" | "unknown" | "sent";

export function evidenceSupports(decision: DeliveryResolutionDecision, outcome?: DeliveryEvidenceOutcome) {
  return decision === "UNRESOLVED" ||
    (decision === "CONFIRMED_DELIVERED" && outcome === "DELIVERED") ||
    (decision === "CONFIRMED_NOT_DELIVERED" && outcome === "NOT_DELIVERED");
}

/** Validate the complete chain, including evidence belonging to this exact attempt. */
export function resolutionChain(attempt: Attempt): { valid: boolean; head?: Resolution } {
  const ordered = [...attempt.resolutions].sort((a, b) => a.revision - b.revision);
  const evidence = new Map(attempt.providerEvents.map((event) => [event.id, event.outcome]));
  const seen = new Set<string>();
  let head: Resolution | undefined;
  for (const row of ordered) {
    const outcome = row.evidenceEventId ? evidence.get(row.evidenceEventId) : undefined;
    if (seen.has(row.id) || row.revision !== seen.size + 1 || row.supersedesId !== (head?.id ?? null) ||
      (row.evidenceEventId && outcome === undefined) || !evidenceSupports(row.decision, outcome)) {
      return { valid: false };
    }

    seen.add(row.id);
    head = row;
  }
  return { valid: true, head };
}

/** Shared among dispatch, invoice scans, and recovery. A blocked attempt never borrows another attempt's resolution. */
export function assessDelivery(history: History): DeliveryBlock | null {
  if (history.deliveryAttempts.some((attempt) => attempt.incidents.length)) return "frozen";
  if (history.status === "SENDING") return "in_progress";

  let sent = history.status === "SENT";
  let unknown = history.status === "UNCERTAIN" && !history.deliveryAttempts.some((attempt) => attempt.status === "UNKNOWN");
  for (const attempt of history.deliveryAttempts) {
    if (attempt.status === "PENDING") return "in_progress";
    if (attempt.providerEvents.some(({ evidenceMetadata }) => evidenceMetadata !== null &&
      typeof evidenceMetadata === "object" && !Array.isArray(evidenceMetadata) && evidenceMetadata.idempotencyConflict === true)) {
      return "invalid_history";
    }
    const { valid, head } = resolutionChain(attempt);
    if (!valid) return "invalid_history";
    if (attempt.status === "SUCCESS" || attempt.providerEvents.some((event) => event.outcome === "DELIVERED")) {
      sent = true;
    }
    if (head?.decision === "UNRESOLVED" ||
      ((attempt.status === "UNKNOWN" || attempt.providerEvents.some((event) => event.outcome === "ACCEPTED")) &&
        head?.decision !== "CONFIRMED_NOT_DELIVERED")) {
      // Confirmed positive evidence itself blocks duplicates. Remaining UNKNOWNs still block invoice progression.
      if (head?.decision !== "CONFIRMED_DELIVERED") unknown = true;
    }
  }
  return unknown ? "unknown" : sent ? "sent" : null;
}

export const deliveryHistorySelect = {
  id: true,
  organizationId: true,
  invoiceId: true,
  customerId: true,
  purpose: true,
  status: true,
  sentAt: true,
  deliveryAttempts: {
    select: {
      id: true, status: true, completedAt: true,
      providerEvents: { select: { id: true, outcome: true, evidenceMetadata: true } },
      incidents: { where: { status: "OPEN" }, select: { id: true }, take: 1 },
      resolutions: {
        select: { id: true, revision: true, supersedesId: true, decision: true, evidenceEventId: true },
      },
    },
  },
} satisfies Prisma.CommunicationSelect;

export function blocksInvoice(block: DeliveryBlock | null) {
  return block !== null && block !== "sent";
}

export async function findBlockedDeliveryInvoices(
  tx: Prisma.TransactionClient,
  organizationId: string,
  invoiceIds: string[],
  exceptCommunicationId?: string,
  includeDraft = false,
) {
  if (!invoiceIds.length) return new Set<string>();
  const communications = await tx.communication.findMany({
    where: {
      organizationId, invoiceId: { in: invoiceIds }, id: exceptCommunicationId ? { not: exceptCommunicationId } : undefined,
      OR: [
        { status: { in: includeDraft ? ["DRAFT", "SENDING", "UNCERTAIN"] : ["SENDING", "UNCERTAIN"] } },
        { deliveryAttempts: { some: {
          OR: [
            { status: { in: ["PENDING", "UNKNOWN"] } },
            { resolutions: { some: {} } },
            { providerEvents: { some: {} } },
            { incidents: { some: { status: "OPEN" } } },
          ],
        } } },
      ],
    },
    select: deliveryHistorySelect,
  });
  return new Set(communications
    .filter((communication) => (includeDraft && communication.status === "DRAFT") || blocksInvoice(assessDelivery(communication)))
    .map((communication) => communication.invoiceId));
}

export async function lockDeliveryInvoice(tx: Prisma.TransactionClient, organizationId: string, invoiceId: string) {
  const [invoice] = await tx.$queryRaw<{ id: string; customerId: string; status: "OPEN" | "CANCELLED"; amountMinor: bigint }[]>`
    SELECT id, "customerId", status, "amountMinor" FROM invoices
    WHERE id = ${invoiceId} AND "organizationId" = ${organizationId}
    FOR NO KEY UPDATE
  `;
  if (!invoice) throw new CommunicationResourceNotFoundError("Invoice");
  return invoice;
}

/** All writers that can alter delivery eligibility lock communication, then invoice. */
export async function lockDeliveryCommunication(tx: Prisma.TransactionClient, organizationId: string, communicationId: string) {
  const [communication] = await tx.$queryRaw<{ id: string; invoiceId: string; status: CommunicationStatus }[]>`
    SELECT id, "invoiceId", status FROM communications
    WHERE id = ${communicationId} AND "organizationId" = ${organizationId}
    FOR UPDATE
  `;
  if (!communication) throw new CommunicationResourceNotFoundError("Communication");
  const invoice = await lockDeliveryInvoice(tx, organizationId, communication.invoiceId);
  const details = await tx.communication.findFirst({
    where: { id: communicationId, organizationId, invoiceId: invoice.id, customerId: invoice.customerId,
      customer: { organizationId }, actionProposal: { organizationId, invoiceId: invoice.id, customerId: invoice.customerId } },
    select: { id: true, invoiceId: true, customerId: true, actionProposalId: true, channel: true },
  });
  if (!details) throw new CommunicationResourceNotFoundError("Communication");
  return { ...communication, ...details, invoice };
}
