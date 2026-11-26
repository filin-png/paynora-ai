import { prisma } from "@/server/db/client";

import { recordVerifiedDeliveryWebhook } from "./delivery-provider-events";
import { resolveDelivery } from "./delivery-resolutions";

/** Synthetic evidence from the test adapter. Never register it as an application provider. */
export async function resolveTestNonDelivery(organizationId: string, communicationId: string, userId: string, attemptId: string) {
  const attempt = await prisma.deliveryAttempt.update({
    where: { id: attemptId, organizationId, communicationId },
    data: { providerAccountRef: `fixture:${organizationId}` },
    include: { communication: { select: { actionProposalId: true } } },
  });
  await recordVerifiedDeliveryWebhook(attempt.provider, {
    attemptKey: attempt.idempotencyKey,
    providerAccountRef: attempt.providerAccountRef!,
    externalEventId: `test-rejected:${attemptId}`,
    outcome: "NOT_DELIVERED",
  });
  const evidence = await prisma.deliveryProviderEvent.findFirstOrThrow({
    where: { organizationId, communicationId, deliveryAttemptId: attemptId, outcome: "NOT_DELIVERED" },
  });
  return resolveDelivery({ organizationId, userId }, { communicationId, proposalId: attempt.communication.actionProposalId }, {
    attemptId, previousId: null, decision: "CONFIRMED_NOT_DELIVERED", evidenceEventId: evidence.id,
    reason: "Fixture provider proved non-delivery",
  });
}
