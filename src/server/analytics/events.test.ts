import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { createFakeAnalyticsProvider } from "./providers/fake";
import { trackEvent } from "./events";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

describe("trackEvent", () => {
  it("forwards the event to the given provider", async () => {
    const provider = createFakeAnalyticsProvider();
    trackEvent("invoice_created", { organizationId: "org_1", properties: { currency: "USD" } }, provider);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(provider.events).toHaveLength(1);
    expect(provider.events[0]).toMatchObject({ name: "invoice_created", organizationId: "org_1" });
  });

  it("strips a property whose key looks sensitive, even if a caller passes one by mistake", async () => {
    const provider = createFakeAnalyticsProvider();
    trackEvent(
      "wallet_connected",
      { organizationId: "org_1", properties: { network: "ETHEREUM", apiKey: "sk-should-never-be-sent" } as never },
      provider,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(provider.events[0]!.properties).toEqual({ network: "ETHEREUM" });
  });

  it("strips every wallet/auth-secret-shaped key a caller might accidentally include (private key, seed phrase, password, session token)", async () => {
    const provider = createFakeAnalyticsProvider();
    trackEvent(
      "wallet_connected",
      {
        organizationId: "org_1",
        properties: {
          network: "ETHEREUM",
          privateKey: "0xdeadbeef",
          seedPhrase: "abandon abandon abandon",
          walletPassword: "hunter2",
          authToken: "bearer-abc",
          sessionSecret: "s3cr3t",
        } as never,
      },
      provider,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(provider.events[0]!.properties).toEqual({ network: "ETHEREUM" });
  });

  it("never throws when the provider itself rejects", () => {
    const failing = { name: "failing", capture: () => Promise.reject(new Error("vendor down")) };
    expect(() => trackEvent("user_signed_in", {}, failing)).not.toThrow();
  });

  it("does not fire when the organization has opted out of analytics (Settings -> Privacy)", async () => {
    const { organization } = await createTestOrganization();
    await prisma.organization.update({ where: { id: organization.id }, data: { analyticsEnabled: false } });
    const provider = createFakeAnalyticsProvider();

    trackEvent("invoice_created", { organizationId: organization.id }, provider);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(provider.events).toHaveLength(0);
  });

  it("fires normally for an organization that has not opted out (the default)", async () => {
    const { organization } = await createTestOrganization();
    const provider = createFakeAnalyticsProvider();

    trackEvent("invoice_created", { organizationId: organization.id }, provider);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(provider.events).toHaveLength(1);
  });

  it("still fires for events with no organizationId regardless of any organization's opt-out (no per-org preference to check)", async () => {
    const provider = createFakeAnalyticsProvider();

    trackEvent("user_signed_in", { userId: "user_1" }, provider);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(provider.events).toHaveLength(1);
  });
});
