import type { Prisma } from "@prisma/client";

import { InvalidActionProposalForCommunicationError } from "./errors";

export const reminderOriginSelect = {
  insight: { select: { businessEvent: { select: { organizationId: true, type: true, data: true } } } },
  collectionStepExecution: { select: { organizationId: true, step: { select: { action: true } } } },
} satisfies Prisma.ActionProposalInclude;

type ReminderProposal = Prisma.ActionProposalGetPayload<{ include: typeof reminderOriginSelect }>;

export function assertCustomerReminder(proposal: ReminderProposal, organizationId: string): void {
  const event = proposal.insight.businessEvent;
  const execution = proposal.collectionStepExecution;
  const data = event.data;
  // A historical proposal may exist even if the worker died before linking it.
  const isCollectionReminder =
    event.type === "COLLECTION_STEP_DUE" &&
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    data.stepAction === "SEND_PAYMENT_REMINDER" &&
    (!execution ||
      (execution.organizationId === organizationId && execution.step.action === "SEND_PAYMENT_REMINDER"));

  if (
    proposal.type !== "SEND_PAYMENT_REMINDER" ||
    proposal.organizationId !== organizationId ||
    event.organizationId !== organizationId ||
    !((event.type === "INVOICE_OVERDUE" && !execution) || isCollectionReminder)
  ) {
    throw new InvalidActionProposalForCommunicationError("Proposal origin does not allow a customer reminder");
  }
}
