import { beforeEach, describe, expect, it } from "vitest";

import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { submitSupportRequest } from "./service";

beforeEach(async () => {
  await resetDatabase();
});

describe("submitSupportRequest", () => {
  it("persists a support request scoped to the calling organization and user", async () => {
    const { organization, user } = await createTestOrganization();

    const request = await submitSupportRequest(organization.id, user.id, { message: "Need help with imports." });

    expect(request.organizationId).toBe(organization.id);
    expect(request.userId).toBe(user.id);
    expect(request.message).toBe("Need help with imports.");

    const reloaded = await prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(reloaded.message).toBe("Need help with imports.");
  });

  it("trims surrounding whitespace from the message", async () => {
    const { organization, user } = await createTestOrganization();

    const request = await submitSupportRequest(organization.id, user.id, { message: "  Hello there.  " });

    expect(request.message).toBe("Hello there.");
  });

  it("rejects an empty (or whitespace-only) message", async () => {
    const { organization, user } = await createTestOrganization();

    await expect(submitSupportRequest(organization.id, user.id, { message: "   " })).rejects.toThrow(
      "cannot be empty",
    );

    const count = await prisma.supportRequest.count({ where: { organizationId: organization.id } });
    expect(count).toBe(0);
  });

  it("rejects a message beyond the length limit", async () => {
    const { organization, user } = await createTestOrganization();

    await expect(
      submitSupportRequest(organization.id, user.id, { message: "a".repeat(4001) }),
    ).rejects.toThrow("4000 characters or fewer");
  });

  it("records a SUPPORT_REQUEST_SUBMITTED activity event", async () => {
    const { organization, user } = await createTestOrganization();

    await submitSupportRequest(organization.id, user.id, { message: "Question about billing." });

    const activity = await prisma.activityEvent.findFirst({
      where: { organizationId: organization.id, type: "SUPPORT_REQUEST_SUBMITTED" },
    });
    expect(activity).not.toBeNull();
  });

  it("is tenant-scoped: a request for one organization never appears under another", async () => {
    const { organization: orgA, user: userA } = await createTestOrganization("Org A");
    const { organization: orgB } = await createTestOrganization("Org B");

    await submitSupportRequest(orgA.id, userA.id, { message: "Org A's question." });

    const forB = await prisma.supportRequest.count({ where: { organizationId: orgB.id } });
    expect(forB).toBe(0);
  });
});
