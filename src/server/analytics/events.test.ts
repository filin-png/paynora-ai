import { describe, expect, it } from "vitest";

import { createFakeAnalyticsProvider } from "./providers/fake";
import { trackEvent } from "./events";

describe("trackEvent", () => {
  it("forwards the event to the given provider", async () => {
    const provider = createFakeAnalyticsProvider();
    trackEvent("invoice_created", { organizationId: "org_1", properties: { currency: "USD" } }, provider);
    await new Promise((resolve) => setTimeout(resolve, 0));

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
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(provider.events[0]!.properties).toEqual({ network: "ETHEREUM" });
  });

  it("never throws when the provider itself rejects", () => {
    const failing = { name: "failing", capture: () => Promise.reject(new Error("vendor down")) };
    expect(() => trackEvent("user_signed_in", {}, failing)).not.toThrow();
  });
});
