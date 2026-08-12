import { Prisma, type ActionProposal, type Communication } from "@prisma/client";

import { tryGenerateStructured } from "@/server/ai/service";
import { recordActivityEvent } from "@/server/ar/activity";
import { getCustomer } from "@/server/ar/customers";
import { buildDeterministicInvoiceContext } from "@/server/ar/reminder-context";
import { prisma } from "@/server/db/client";
import { buildReminderEmailRequest } from "./ai-context";
import { resolveCommunicationDestination } from "./channel";
import {
  CommunicationChannelBlockedError,
  CommunicationResourceNotFoundError,
  InvalidActionProposalForCommunicationError,
} from "./errors";
import { buildDeterministicReminderEmail, type ReminderEmailContext } from "./templates";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

async function getTenantActionProposal(
  organizationId: string,
  actionProposalId: string,
): Promise<ActionProposal> {
  const proposal = await prisma.actionProposal.findFirst({
    where: { id: actionProposalId, organizationId },
  });
  if (!proposal) throw new CommunicationResourceNotFoundError("Action proposal");
  return proposal;
}

async function generateReminderEmail(context: ReminderEmailContext) {
  const aiResult = await tryGenerateStructured(buildReminderEmailRequest(context));
  if (!aiResult) {
    return { ...buildDeterministicReminderEmail(context), aiGenerated: false as const };
  }
  return { subject: aiResult.data.subject, body: aiResult.data.body, aiGenerated: true as const, aiProvider: aiResult.provider };
}

export type EnsuredCommunication = { communication: Communication; created: boolean };

/**
 * Idempotent: a second call for the same proposal finds the existing
 * Communication via the unique constraint on `actionProposalId` rather
 * than creating a duplicate or re-running AI — same pattern as
 * src/server/operator/insights.ts's ensureInsightForInvoiceOverdueEvent.
 * A fresh draft can only be created from a proposal that is APPROVED and
 * of the allowlisted SEND_PAYMENT_REMINDER type; once a Communication
 * exists for a proposal, this always returns it unchanged regardless of
 * the proposal's current status (including EXECUTED) — preparing is a
 * read-through-or-create operation, not a status check on every call.
 * See docs/communications.md.
 */
export async function prepareReminderCommunication(
  organizationId: string,
  actionProposalId: string,
): Promise<EnsuredCommunication> {
  const proposal = await getTenantActionProposal(organizationId, actionProposalId);

  const existing = await prisma.communication.findUnique({
    where: { actionProposalId: proposal.id },
  });
  if (existing) return { communication: existing, created: false };

  if (proposal.type !== "SEND_PAYMENT_REMINDER") {
    throw new InvalidActionProposalForCommunicationError(
      `Cannot prepare a communication for action type "${proposal.type}"`,
    );
  }
  if (proposal.status !== "APPROVED") {
    throw new InvalidActionProposalForCommunicationError(
      `Action proposal must be APPROVED before a communication can be prepared (current status: ${proposal.status})`,
    );
  }
  if (!proposal.customerId || !proposal.invoiceId) {
    throw new InvalidActionProposalForCommunicationError(
      "Action proposal is missing a customer or invoice reference",
    );
  }

  const [customer, organization, invoiceContext] = await Promise.all([
    getCustomer(organizationId, proposal.customerId),
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
    buildDeterministicInvoiceContext(organizationId, proposal.invoiceId),
  ]);

  const destination = resolveCommunicationDestination(customer);
  if (destination.blocked) throw new CommunicationChannelBlockedError(destination.reason);

  const emailContext: ReminderEmailContext = { ...invoiceContext, organizationName: organization.name };
  const content = await generateReminderEmail(emailContext);
  const channelLabel = destination.channel === "EMAIL" ? "email" : "Telegram message";

  try {
    const communication = await prisma.$transaction(async (tx) => {
      const created = await tx.communication.create({
        data: {
          organizationId,
          customerId: proposal.customerId!,
          invoiceId: proposal.invoiceId!,
          actionProposalId: proposal.id,
          channel: destination.channel,
          purpose: "PAYMENT_REMINDER",
          recipient: destination.destination,
          subject: content.subject,
          body: content.body,
          aiGenerated: content.aiGenerated,
          aiProvider: "aiProvider" in content ? content.aiProvider : undefined,
        },
      });
      await recordActivityEvent(tx, {
        organizationId,
        type: "COMMUNICATION_PREPARED",
        summary: `Payment reminder ${channelLabel} drafted for invoice ${proposal.invoiceId}`,
        customerId: proposal.customerId ?? undefined,
        invoiceId: proposal.invoiceId ?? undefined,
      });
      return created;
    });
    return { communication, created: true };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_CONSTRAINT_VIOLATION
    ) {
      const raced = await prisma.communication.findUniqueOrThrow({
        where: { actionProposalId: proposal.id },
      });
      return { communication: raced, created: false };
    }
    throw error;
  }
}

export async function getCommunicationForProposal(
  organizationId: string,
  actionProposalId: string,
): Promise<Communication | null> {
  return prisma.communication.findFirst({ where: { organizationId, actionProposalId } });
}

export async function getCommunication(
  organizationId: string,
  communicationId: string,
): Promise<Communication> {
  const communication = await prisma.communication.findFirst({
    where: { id: communicationId, organizationId },
  });
  if (!communication) throw new CommunicationResourceNotFoundError("Communication");
  return communication;
}
