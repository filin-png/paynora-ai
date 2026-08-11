import { beforeEach, describe, expect, it } from "vitest";

import { resetDatabase } from "@/server/db/test-utils";
import { enrollInvoice } from "./enrollment";
import { InvalidSequenceTransitionError } from "./errors";
import {
  getCollectionStatusForInvoice,
  pauseCollectionSequence,
  resumeCollectionSequence,
  stopCollectionSequenceManually,
} from "./sequences";
import { createAutomationReadyOrg, createTestInvoice } from "./test-fixtures";

beforeEach(async () => {
  await resetDatabase();
});

async function setup() {
  const { organization, customer, policy } = await createAutomationReadyOrg();
  const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
  const { sequence } = await enrollInvoice(organization.id, invoice.id, customer.id, policy.id, policy.currentVersion);
  return { organization, customer, policy, invoice, sequence };
}

describe("pauseCollectionSequence / resumeCollectionSequence", () => {
  it("pauses an ACTIVE sequence and resumes it back to ACTIVE", async () => {
    const { organization, sequence } = await setup();

    const paused = await pauseCollectionSequence(organization.id, sequence.id);
    expect(paused.status).toBe("PAUSED");
    expect(paused.pausedAt).not.toBeNull();

    const resumed = await resumeCollectionSequence(organization.id, sequence.id);
    expect(resumed.status).toBe("ACTIVE");
    expect(resumed.pausedAt).toBeNull();
  });

  it("pausing an already-PAUSED sequence is an idempotent no-op", async () => {
    const { organization, sequence } = await setup();
    await pauseCollectionSequence(organization.id, sequence.id);
    const again = await pauseCollectionSequence(organization.id, sequence.id);
    expect(again.status).toBe("PAUSED");
  });

  it("resuming an already-ACTIVE sequence is an idempotent no-op", async () => {
    const { organization, sequence } = await setup();
    const result = await resumeCollectionSequence(organization.id, sequence.id);
    expect(result.status).toBe("ACTIVE");
  });

  it("rejects resuming a STOPPED sequence", async () => {
    const { organization, sequence } = await setup();
    await stopCollectionSequenceManually(organization.id, sequence.id);
    await expect(resumeCollectionSequence(organization.id, sequence.id)).rejects.toThrow(
      InvalidSequenceTransitionError,
    );
  });

  it("rejects pause for a sequence from another organization", async () => {
    const { sequence } = await setup();
    const other = await createAutomationReadyOrg("Other");
    await expect(pauseCollectionSequence(other.organization.id, sequence.id)).rejects.toThrow();
  });

  it("rejects resume for a sequence from another organization, and never actually resumes it", async () => {
    const { organization, sequence } = await setup();
    await pauseCollectionSequence(organization.id, sequence.id);
    const other = await createAutomationReadyOrg("Other2");

    await expect(resumeCollectionSequence(other.organization.id, sequence.id)).rejects.toThrow();

    const stillPaused = await import("@/server/db/client").then(({ prisma }) =>
      prisma.collectionSequence.findUniqueOrThrow({ where: { id: sequence.id } }),
    );
    expect(stillPaused.status).toBe("PAUSED");
  });
});

describe("stopCollectionSequenceManually", () => {
  it("stops an ACTIVE sequence with reason MANUAL", async () => {
    const { organization, sequence } = await setup();
    const stopped = await stopCollectionSequenceManually(organization.id, sequence.id);
    expect(stopped.status).toBe("STOPPED");
    expect(stopped.stopReason).toBe("MANUAL");
  });

  it("rejects stopping an already-STOPPED sequence a second time with a different outcome", async () => {
    const { organization, sequence } = await setup();
    await stopCollectionSequenceManually(organization.id, sequence.id);
    const again = await stopCollectionSequenceManually(organization.id, sequence.id);
    expect(again.status).toBe("STOPPED");
  });

  it("rejects stopping a sequence from another organization, and never actually stops it", async () => {
    const { sequence } = await setup();
    const other = await createAutomationReadyOrg("Other3");
    await expect(stopCollectionSequenceManually(other.organization.id, sequence.id)).rejects.toThrow();

    const { prisma } = await import("@/server/db/client");
    const stillActive = await prisma.collectionSequence.findUniqueOrThrow({ where: { id: sequence.id } });
    expect(stillActive.status).toBe("ACTIVE");
  });
});

describe("getCollectionStatusForInvoice", () => {
  it("reports not_enrolled for an invoice with no sequence", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    const invoice = await createTestInvoice(organization.id, customer.id, "2026-01-01");
    const status = await getCollectionStatusForInvoice(organization.id, invoice.id);
    expect(status.kind).toBe("not_enrolled");
  });

  it("reports active with step counts before any step has executed", async () => {
    const { organization, sequence } = await setup();
    const status = await getCollectionStatusForInvoice(organization.id, sequence.invoiceId);
    expect(status).toMatchObject({ kind: "active", stepsCompleted: 0, stepCount: 4, nextStepDaysAfterDue: 1 });
  });

  it("reports paused", async () => {
    const { organization, sequence } = await setup();
    await pauseCollectionSequence(organization.id, sequence.id);
    const status = await getCollectionStatusForInvoice(organization.id, sequence.invoiceId);
    expect(status.kind).toBe("paused");
  });
});
