import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createCustomer } from "@/server/ar/customers";
import { createInvoice } from "@/server/ar/invoices";
import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import type { EmailProvider } from "@/server/email/types";
import { requireOrganizationMembership, requireOrganizationRole } from "@/server/tenancy/context";
import { OrganizationAccessDeniedError } from "@/server/tenancy/errors";

import { deleteStage4aTestOrganization, hasStage4aAdminTestConfiguration } from "./delivery-admin-test-fixture";
import { DeliveryEventConflictError } from "./delivery-evidence";
import { recordVerifiedDeliveryWebhook } from "./delivery-provider-events";
import { resolveDelivery } from "./delivery-resolutions";
import { resolveTestNonDelivery } from "./delivery-test-fixtures";
import { sendCommunication } from "./send";

const scenario = vi.hoisted(() => ({ reject: "" }));
vi.mock("@/server/ar/activity", async (original) => {
  const actual = await original<typeof import("@/server/ar/activity")>();
  return {
    ...actual,
    recordActivityEvent: async (...args: Parameters<typeof actual.recordActivityEvent>) => {
      if (args[1].type !== scenario.reject) return actual.recordActivityEvent(...args);
      return actual.recordActivityEvent(args[0], { ...args[1], customerId: "missing-delivery-audit-fixture" });
    },
  };
});

beforeAll(async () => {
  const [identity] = await prisma.$queryRaw<{ ok: boolean }[]>`
    SELECT current_database() = 'paynora_test'
      AND session_user = 'paynora_test_runner' AND current_user = 'paynora_test_runner'
      AND inet_server_addr() = '127.0.0.1'::inet AND inet_server_port() = 55432
      AND current_schema() = 'public' AND current_setting('cluster_name', true) = 'paynora_test_isolated'
      AND current_setting('server_version_num')::int / 10000 = 17
      AND current_setting('transaction_read_only') = 'off'
      AND NOT has_schema_privilege(current_user, 'public', 'CREATE')
      AND NOT has_table_privilege(current_user, 'public._prisma_migrations', 'DELETE')
      AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'paynora')
      AS ok
  `;
  expect(identity?.ok).toBe(true);
});

beforeEach(async () => {
  scenario.reject = "";
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function fixture() {
  const { organization, user } = await createTestOrganization();
  const customer = await createCustomer(organization.id, { name: "Fixture", email: "fixture@example.test" });
  const invoice = await createInvoice(organization.id, {
    customerId: customer.id, number: "Stage-4A", currency: "USD", amountMinor: 500n,
    issueDate: "2020-01-01", dueDate: "2020-01-02",
  });
  const scope = { organizationId: organization.id, invoiceId: invoice.id, customerId: customer.id };
  const event = await prisma.businessEvent.create({
    data: { ...scope, type: "INVOICE_OVERDUE", dedupeKey: invoice.id, data: {} },
  });
  const insight = await prisma.operatorInsight.create({
    data: { ...scope, businessEventId: event.id, summary: "Fixture", priority: "LOW" },
  });
  const proposal = await prisma.actionProposal.create({
    data: { ...scope, insightId: insight.id, type: "SEND_PAYMENT_REMINDER", status: "APPROVED", reasoning: "Fixture" },
  });
  const communication = await prisma.communication.create({
    data: { ...scope, actionProposalId: proposal.id, purpose: "PAYMENT_REMINDER", recipient: "fixture@example.test",
      subject: "Fixture", body: "Fixture", status: "FAILED" },
  });
  const attemptScope = { organizationId: organization.id, communicationId: communication.id };
  const addAttempt = (attemptNumber: number, status: "UNKNOWN" | "FAILED" = "UNKNOWN") => prisma.deliveryAttempt.create({
    data: { ...attemptScope, attemptNumber, status, provider: "fixture", completedAt: new Date(),
      providerAccountRef: `fixture:${organization.id}`, idempotencyKey: `${communication.id}:${attemptNumber}` },
  });
  return { organization, user, actor: { organizationId: organization.id, userId: user.id },
    target: { communicationId: communication.id, proposalId: proposal.id }, attemptScope, addAttempt };
}

function fakeSend() {
  return vi.fn<EmailProvider["send"]>(async () => ({ provider: "fixture" }));
}


function unresolved(attemptId: string) {
  return { attemptId, previousId: null, decision: "UNRESOLVED" as const, reason: "Awaiting evidence" };
}

async function expectNoResolutionOrAudit(organizationId: string) {
  expect(await prisma.deliveryResolution.count({ where: { organizationId } })).toBe(0);
  expect(await prisma.activityEvent.count({
    where: { organizationId, type: "DELIVERY_RESOLUTION_RECORDED" },
  })).toBe(0);
}

function insertResolutionRows(
  f: Awaited<ReturnType<typeof fixture>>,
  attemptId: string,
  rows: { id: string; revision: number; supersedesId: string | null }[],
) {
  const values = rows.map(({ id, revision, supersedesId }) => Prisma.sql`
    (${id}, ${f.actor.organizationId}, ${f.target.communicationId}, ${attemptId},
     ${f.actor.userId}, ${revision}, ${supersedesId}, 'UNRESOLVED', 'Direct PostgreSQL fixture')
  `);
  return prisma.$executeRaw`
    INSERT INTO public.delivery_resolutions
      (id, "organizationId", "communicationId", "deliveryAttemptId",
       "operatorId", revision, "supersedesId", decision, reason)
    VALUES ${Prisma.join(values)}
  `;
}

function postgresError(code: string, message: string | RegExp) {
  return {
    code: "P2010",
    meta: { driverAdapterError: { cause: { originalCode: code } } },
    message: typeof message === "string" ? expect.stringContaining(message) : expect.stringMatching(message),
  };
}

async function seedOpenIncident(f: Awaited<ReturnType<typeof fixture>>) {
  const attempt = await f.addAttempt(1);
  const resolution = await resolveTestNonDelivery(f.actor.organizationId, f.target.communicationId, f.actor.userId, attempt.id);
  await recordVerifiedDeliveryWebhook("fixture", {
    attemptKey: attempt.idempotencyKey, providerAccountRef: attempt.providerAccountRef!,
    externalEventId: `test-late:${attempt.id}`, outcome: "DELIVERED",
  });
  const incident = await prisma.deliveryIncident.findFirstOrThrow({
    where: { ...f.attemptScope, deliveryAttemptId: attempt.id, status: "OPEN" },
  });
  expect(incident.priorResolutionId).toBe(resolution.id);
}

async function countDeliveryGraph(organizationId: string) {
  const where = { organizationId };
  const [organization, memberships, customer, invoice, event, insight, proposal, communication, attempt,
    resolutions, providerEvents, incidents, audit] = await Promise.all([
    prisma.organization.count({ where: { id: organizationId } }),
    prisma.organizationMember.count({ where }),
    prisma.customer.count({ where }),
    prisma.invoice.count({ where }),
    prisma.businessEvent.count({ where }),
    prisma.operatorInsight.count({ where }),
    prisma.actionProposal.count({ where }),
    prisma.communication.count({ where }),
    prisma.deliveryAttempt.count({ where }),
    prisma.deliveryResolution.count({ where }),
    prisma.deliveryProviderEvent.count({ where }),
    prisma.deliveryIncident.count({ where }),
    prisma.activityEvent.count({ where }),
  ]);
  return { organization, memberships, customer, invoice, event, insight, proposal, communication, attempt,
    resolutions, providerEvents, incidents, audit };
}

describe("Stage 4A PostgreSQL delivery resolution", () => {
  it("blocks historical UNKNOWN until each attempt is resolved and allows only one concurrent retry", async () => {
    const f = await fixture();
    const one = await f.addAttempt(1);
    const two = await f.addAttempt(2);
    await f.addAttempt(3, "FAILED");
    await f.addAttempt(4, "FAILED");
    const send = fakeSend();
    const retry = () => sendCommunication(f.actor.organizationId, f.target.communicationId, f.actor.userId, { provider: { name: "fixture", send } });
    await expect(retry()).rejects.toThrow("delivery review");
    await resolveTestNonDelivery(f.actor.organizationId, f.target.communicationId, f.actor.userId, one.id);
    await expect(retry()).rejects.toThrow("delivery review");
    expect(send).not.toHaveBeenCalled();
    await resolveTestNonDelivery(f.actor.organizationId, f.target.communicationId, f.actor.userId, two.id);
    const results = await Promise.allSettled([retry(), retry()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await prisma.deliveryAttempt.count({ where: f.attemptScope })).toBe(5);
    expect(await prisma.deliveryAttempt.findUniqueOrThrow({ where: { id: one.id } })).toMatchObject({ status: "UNKNOWN" });
  });

  it("serializes resolution racing with a retry", async () => {
    const f = await fixture();
    const attempt = await f.addAttempt(1);
    const send = fakeSend();
    const retry = () => sendCommunication(f.actor.organizationId, f.target.communicationId, f.actor.userId, { provider: { name: "fixture", send } });
    const [resolution, dispatch] = await Promise.allSettled([
      resolveTestNonDelivery(f.actor.organizationId, f.target.communicationId, f.actor.userId, attempt.id), retry(),
    ]);
    expect(resolution.status).toBe("fulfilled");
    if (dispatch.status === "rejected") {
      expect(send).not.toHaveBeenCalled();
      expect(await prisma.deliveryAttempt.count({ where: f.attemptScope })).toBe(1);
      await retry();
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(await prisma.deliveryAttempt.count({ where: f.attemptScope })).toBe(2);
  });

  it("deduplicates concurrent verified events, freezes and closes only with audited resolution", async () => {
    const f = await fixture();
    const attempt = await f.addAttempt(1);
    const prior = await resolveTestNonDelivery(f.actor.organizationId, f.target.communicationId, f.actor.userId, attempt.id);
    const event = {
      attemptKey: attempt.idempotencyKey, providerAccountRef: attempt.providerAccountRef!,
      externalEventId: "late-success", outcome: "DELIVERED",
    } as const;
    const results = await Promise.all([recordVerifiedDeliveryWebhook("fixture", event), recordVerifiedDeliveryWebhook("fixture", event)]);
    expect(results.filter((result) => result.incidentCreated)).toHaveLength(1);
    await expect(recordVerifiedDeliveryWebhook("fixture", { ...event, outcome: "INCONCLUSIVE" }))
      .rejects.toThrow(DeliveryEventConflictError);
    const incident = await prisma.deliveryIncident.findFirstOrThrow({ where: f.attemptScope });
    const send = fakeSend();
    const retry = () => sendCommunication(f.actor.organizationId, f.target.communicationId, f.actor.userId, { provider: { name: "fixture", send } });
    await expect(retry()).rejects.toThrow("delivery review");
    await expect(resolveDelivery(f.actor, f.target, { attemptId: attempt.id, previousId: prior.id,
      incidentId: incident.id, decision: "UNRESOLVED", reason: "No conclusion" })).rejects.toThrow("open incident");
    expect(await prisma.deliveryIncident.count({ where: { ...f.attemptScope, status: "OPEN" } })).toBe(1);
    const result = await resolveDelivery(f.actor, f.target, {
      attemptId: attempt.id, previousId: prior.id, incidentId: incident.id, evidenceEventId: incident.providerEventId,
      decision: "CONFIRMED_DELIVERED", reason: "Verified late delivery",
    });
    expect(await prisma.deliveryIncident.findUniqueOrThrow({ where: { id: incident.id } })).toMatchObject({
      status: "CLOSED", closingResolutionId: result.id,
    });
    expect(await prisma.deliveryResolution.count({ where: f.attemptScope })).toBe(2);
    await expect(retry()).rejects.toThrow("delivery review");
    expect(send).not.toHaveBeenCalled();
  });

  it("commits a conflict barrier before returning a conflicting event error", async () => {
    const f = await fixture();
    const attempt = await f.addAttempt(1);
    await resolveTestNonDelivery(f.actor.organizationId, f.target.communicationId, f.actor.userId, attempt.id);
    await expect(recordVerifiedDeliveryWebhook("fixture", {
      attemptKey: attempt.idempotencyKey, providerAccountRef: attempt.providerAccountRef!,
      externalEventId: `test-rejected:${attempt.id}`, outcome: "INCONCLUSIVE",
    })).rejects.toThrow(DeliveryEventConflictError);
    expect(await prisma.deliveryProviderEvent.count({ where: { ...f.attemptScope, outcome: "INCONCLUSIVE" } })).toBe(1);
    const send = fakeSend();
    await expect(sendCommunication(f.actor.organizationId, f.target.communicationId, f.actor.userId, {
      provider: { name: "fixture", send },
    })).rejects.toThrow("delivery review");
    expect(send).not.toHaveBeenCalled();
  });

  it("rolls back a resolution if its activity event fails", async () => {
    const f = await fixture();
    const attempt = await f.addAttempt(1);
    scenario.reject = "DELIVERY_RESOLUTION_RECORDED";
    await expect(resolveDelivery(f.actor, f.target, {
      attemptId: attempt.id, previousId: null, decision: "UNRESOLVED", reason: "Still unknown",
    })).rejects.toThrow();
    expect(await prisma.deliveryResolution.count({ where: f.attemptScope })).toBe(0);
  });

  it("rolls back the provider event if creating the incident audit fails", async () => {
    const f = await fixture();
    const attempt = await f.addAttempt(1);
    await resolveTestNonDelivery(f.actor.organizationId, f.target.communicationId, f.actor.userId, attempt.id);
    scenario.reject = "DELIVERY_INCIDENT_OPENED";
    await expect(recordVerifiedDeliveryWebhook("fixture", {
      attemptKey: attempt.idempotencyKey, providerAccountRef: attempt.providerAccountRef!,
      externalEventId: "late-failing", outcome: "DELIVERED",
    })).rejects.toThrow();
    expect(await prisma.deliveryProviderEvent.count({ where: { ...f.attemptScope, externalEventId: "late-failing" } })).toBe(0);
    expect(await prisma.deliveryIncident.count({ where: f.attemptScope })).toBe(0);
  });

  it("rejects a foreign tenant and mismatched predecessor at the database boundary", async () => {
    const f = await fixture();
    const other = await fixture();
    const ownerAttempt = await f.addAttempt(1);
    const otherAttempt = await other.addAttempt(1);
    const prior = await resolveTestNonDelivery(f.actor.organizationId, f.target.communicationId, f.actor.userId, ownerAttempt.id);
    const input = { attemptId: ownerAttempt.id, previousId: prior.id, decision: "UNRESOLVED" as const, reason: "Review" };
    await expect(resolveDelivery(other.actor, f.target, input)).rejects.toThrow();
    await expect(prisma.deliveryResolution.create({
      data: { ...other.attemptScope, deliveryAttemptId: otherAttempt.id, operatorId: other.actor.userId,
        supersedesId: prior.id, revision: 2, decision: "UNRESOLVED", reason: "Foreign predecessor" },
    })).rejects.toThrow();
  });

  it("rejects direct and indirect deletion and verifies the full organization cascade separately", async () => {
    const f = await fixture();
    const other = await fixture();
    const attempt = await f.addAttempt(1);
    const prior = await resolveTestNonDelivery(f.actor.organizationId, f.target.communicationId, f.actor.userId, attempt.id);
    await expect(prisma.deliveryResolution.update({ where: { id: prior.id }, data: { reason: "Modified" } })).rejects.toThrow();
    await expect(prisma.deliveryResolution.delete({ where: { id: prior.id } })).rejects.toThrow();
    await expect(prisma.deliveryAttempt.delete({ where: { id: attempt.id } })).rejects.toThrow();
    await expect(prisma.communication.delete({ where: { id: f.target.communicationId } })).rejects.toThrow();
    expect(await prisma.deliveryResolution.findUnique({ where: { id: prior.id } })).toEqual(prior);

    // Gate the candidate on the actual legacy RESTRICT graph as well.
    await prisma.organization.delete({ where: { id: f.actor.organizationId } });
    expect(await prisma.deliveryResolution.count({ where: f.attemptScope })).toBe(0);
    expect(await prisma.deliveryProviderEvent.count({ where: f.attemptScope })).toBe(0);
    expect(await prisma.communication.findUnique({ where: { id: other.target.communicationId } })).not.toBeNull();
  });
  it("denies a verified same-tenant MEMBER without writing a resolution or audit", async () => {
    const f = await fixture();
    const member = await createTestOrganization("Stage 4A member");
    await prisma.organizationMember.create({
      data: { organizationId: f.organization.id, userId: member.user.id, role: "MEMBER" },
    });
    await expect(requireOrganizationMembership(member.user, f.organization.slug)).resolves.toMatchObject({ role: "MEMBER" });
    const attempt = await f.addAttempt(1);

    await expect(resolveDelivery({ ...f.actor, userId: member.user.id }, f.target, unresolved(attempt.id)))
      .rejects.toBeInstanceOf(OrganizationAccessDeniedError);

    await expectNoResolutionOrAudit(f.organization.id);
  });

  it("rechecks OWNER after a concurrent demotion commits while the resolution waits", async () => {
    const f = await fixture();
    const attempt = await f.addAttempt(1);
    await expect(requireOrganizationRole(f.user, f.organization.slug, "OWNER")).resolves.toMatchObject({ role: "OWNER" });

    const updated = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const demotion = prisma.$transaction(async (tx) => {
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await tx.organizationMember.update({
        where: { userId_organizationId: { userId: f.user.id, organizationId: f.organization.id } },
        data: { role: "MEMBER" },
      });
      updated.resolve(pid);
      await release.promise;
    }, { timeout: 10000 });
    void demotion.catch(updated.reject);

    let resolving: Promise<{ error: unknown } | { resolutionId: string }> | undefined;
    try {
      const pid = await updated.promise;
      resolving = resolveDelivery(f.actor, f.target, unresolved(attempt.id)).then(
        (result) => ({ resolutionId: result.id }),
        (error: unknown) => ({ error }),
      );
      await vi.waitFor(async () => {
        const [activity] = await prisma.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE pid <> pg_backend_pid() AND state = 'active'
              AND strpos(query, 'FROM organization_members') > 0 AND strpos(query, 'FOR SHARE') > 0
              AND ${pid}::int = ANY (pg_blocking_pids(pid))
          ) AS waiting
        `;
        expect(activity.waiting, "resolution must wait on the real PostgreSQL membership lock").toBe(true);
      }, { timeout: 3000, interval: 25 });

      release.resolve();
      await demotion;
      expect(await resolving).toEqual({ error: expect.any(OrganizationAccessDeniedError) });
      await expect(requireOrganizationMembership(f.user, f.organization.slug)).resolves.toMatchObject({ role: "MEMBER" });
      await expectNoResolutionOrAudit(f.organization.id);
    } finally {
      release.resolve();
      await Promise.allSettled([demotion, resolving]);
    }
  }, 15000);

  it("rejects cyclic predecessor links in a single PostgreSQL INSERT", async () => {
    const f = await fixture();
    const attempt = await f.addAttempt(1);
    const first = randomUUID();
    const second = randomUUID();

    await expect(insertResolutionRows(f, attempt.id, [
      { id: first, revision: 2, supersedesId: second },
      { id: second, revision: 3, supersedesId: first },
    ])).rejects.toMatchObject(postgresError("23514", "Delivery resolution must reference its immediate predecessor"));

    expect(await prisma.deliveryResolution.count({ where: f.attemptScope })).toBe(0);
  });

  it("rejects a second successor for the same predecessor in PostgreSQL", async () => {
    const f = await fixture();
    const attempt = await f.addAttempt(1);
    const root = randomUUID();
    const successor = randomUUID();
    await expect(insertResolutionRows(f, attempt.id, [{ id: root, revision: 1, supersedesId: null }])).resolves.toBe(1);
    await expect(insertResolutionRows(f, attempt.id, [{ id: successor, revision: 2, supersedesId: root }])).resolves.toBe(1);

    await expect(insertResolutionRows(f, attempt.id, [{ id: randomUUID(), revision: 2, supersedesId: root }]))
      .rejects.toMatchObject(postgresError("23505", /delivery_resolution_(revision|successor)_uq/u));

    const rows = await prisma.deliveryResolution.findMany({
      where: f.attemptScope, orderBy: { revision: "asc" }, select: { id: true, supersedesId: true },
    });
    expect(rows).toEqual([{ id: root, supersedesId: null }, { id: successor, supersedesId: root }]);
  });

  it("rejects a predecessor on another attempt of the same organization and communication", async () => {
    const f = await fixture();
    const first = await f.addAttempt(1);
    const second = await f.addAttempt(2);
    const prior = await resolveTestNonDelivery(f.actor.organizationId, f.target.communicationId, f.actor.userId, first.id);

    await expect(insertResolutionRows(f, second.id, [{ id: randomUUID(), revision: 2, supersedesId: prior.id }]))
      .rejects.toMatchObject(postgresError("23514", "Delivery resolution must reference its immediate predecessor"));

    expect(await prisma.deliveryResolution.count({ where: { ...f.attemptScope, deliveryAttemptId: first.id } })).toBe(1);
    expect(await prisma.deliveryResolution.count({ where: { ...f.attemptScope, deliveryAttemptId: second.id } })).toBe(0);
  });

  // An explicit admin connection is only supplied to the dedicated isolated verification run.
  it.skipIf(!hasStage4aAdminTestConfiguration())("commits an administrative cascade with OPEN incidents and preserves the neighboring graph", async () => {
    const target = await fixture();
    const neighbor = await fixture();
    await seedOpenIncident(target);
    await seedOpenIncident(neighbor);
    const [targetBefore, neighborBefore] = await Promise.all([
      countDeliveryGraph(target.organization.id),
      countDeliveryGraph(neighbor.organization.id),
    ]);
    const populated = {
      organization: 1, memberships: 1, customer: 1, invoice: 1, event: 1, insight: 1, proposal: 1,
      communication: 1, attempt: 1, resolutions: 1, providerEvents: 2, incidents: 1,
    };
    expect(targetBefore).toMatchObject(populated);
    expect(neighborBefore).toMatchObject(populated);
    expect(targetBefore.audit).toBeGreaterThan(0);
    expect(neighborBefore.audit).toBeGreaterThan(0);

    await deleteStage4aTestOrganization(target.organization.id);

    const empty = Object.fromEntries(Object.keys(targetBefore).map((table) => [table, 0]));
    expect(await countDeliveryGraph(target.organization.id)).toEqual(empty);
    expect(await countDeliveryGraph(neighbor.organization.id)).toEqual(neighborBefore);
    await expect(prisma.deliveryIncident.findFirstOrThrow({ where: neighbor.attemptScope }))
      .resolves.toMatchObject({ status: "OPEN" });
  }, 15000);

});
