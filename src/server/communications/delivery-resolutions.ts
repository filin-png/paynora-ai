import { z } from "zod";

import { recordActivityEvent } from "@/server/ar/activity";
import { prisma } from "@/server/db/client";
import { OrganizationAccessDeniedError } from "@/server/tenancy/errors";

import { deliveryHistorySelect, evidenceSupports, lockDeliveryCommunication, resolutionChain } from "./delivery-guard";

export const deliveryResolutionInput = z.object({
  attemptId: z.string().min(1).max(128),
  previousId: z.string().min(1).max(128).nullable(),
  decision: z.enum(["CONFIRMED_DELIVERED", "CONFIRMED_NOT_DELIVERED", "UNRESOLVED"]),
  reason: z.string().trim().min(1).max(1000).refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)),
  evidenceEventId: z.string().min(1).max(128).optional(),
  incidentId: z.string().min(1).max(128).optional(),
});

export async function resolveDelivery(
  actor: { organizationId: string; userId: string },
  target: { communicationId: string; proposalId: string },
  input: z.input<typeof deliveryResolutionInput>,
) {
  const decision = deliveryResolutionInput.parse(input);
  return prisma.$transaction(async (tx) => {
    const [owner] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM organization_members
      WHERE "organizationId" = ${actor.organizationId} AND "userId" = ${actor.userId} AND role = 'OWNER'
      FOR SHARE
    `;
    if (!owner) throw new OrganizationAccessDeniedError();

    const communication = await lockDeliveryCommunication(tx, actor.organizationId, target.communicationId);
    if (communication.actionProposalId !== target.proposalId) throw new OrganizationAccessDeniedError();

    const scope = { organizationId: actor.organizationId, communicationId: communication.id, deliveryAttemptId: decision.attemptId };
    const history = await tx.communication.findFirstOrThrow({
      where: { id: communication.id, organizationId: actor.organizationId },
      select: deliveryHistorySelect,
    });
    const attempt = history.deliveryAttempts.find((row) => row.id === decision.attemptId);
    if (!attempt || attempt.status !== "UNKNOWN") throw new Error("Resolution requires an uncertain attempt");
    const chain = resolutionChain(attempt);
    if (!chain.valid || (chain.head?.id ?? null) !== decision.previousId) {
      throw new Error("Delivery resolution history changed or is inconsistent");
    }

    const evidence = attempt.providerEvents.find((row) => row.id === decision.evidenceEventId);
    if ((decision.evidenceEventId && !evidence) || !evidenceSupports(decision.decision, evidence?.outcome)) {
      throw new Error("Verified evidence for this attempt is required");
    }
    if (decision.decision === "CONFIRMED_NOT_DELIVERED" && attempt.providerEvents.some((row) => row.outcome === "DELIVERED")) {
      throw new Error("Verified delivery contradicts a non-delivery decision");
    }

    const incident = decision.incidentId
      ? await tx.deliveryIncident.findFirst({
          where: { ...scope, id: decision.incidentId, status: "OPEN" },
          select: { id: true },
        })
      : null;
    if (decision.incidentId && (!incident || decision.decision !== "CONFIRMED_DELIVERED")) {
      throw new Error("An open incident requires a new confirmed delivery resolution");
    }

    const resolution = await tx.deliveryResolution.create({
      data: {
        ...scope,
        decision: decision.decision,
        reason: decision.reason,
        evidenceEventId: evidence?.id,
        operatorId: actor.userId,
        supersedesId: decision.previousId,
        revision: (chain.head?.revision ?? 0) + 1,
      },
    });
    const audit = { organizationId: actor.organizationId, customerId: communication.customerId, invoiceId: communication.invoiceId };
    await recordActivityEvent(tx, {
      ...audit,
      type: "DELIVERY_RESOLUTION_RECORDED",
      summary: "Delivery resolution recorded",
      metadata: { operatorId: actor.userId, attemptId: attempt.id, resolutionId: resolution.id, decision: resolution.decision },
    });

    if (incident) {
      const result = await tx.deliveryIncident.updateMany({
        where: { ...scope, id: incident.id, status: "OPEN" },
        data: { status: "CLOSED", closingResolutionId: resolution.id, closedAt: new Date() },
      });
      if (result.count !== 1) throw new Error("Delivery incident changed concurrently");
      await recordActivityEvent(tx, {
        ...audit,
        type: "DELIVERY_INCIDENT_CLOSED",
        summary: "Delivery incident closed with verified evidence",
        metadata: { operatorId: actor.userId, incidentId: incident.id, resolutionId: resolution.id },
      });
    }
    return resolution;
  }, { isolationLevel: "ReadCommitted" });
}
