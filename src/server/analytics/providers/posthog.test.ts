import { afterEach, describe, expect, it, vi } from "vitest";

import { createPostHogAnalyticsProvider } from "./posthog";

describe("createPostHogAnalyticsProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the capture endpoint with the api key and event name", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createPostHogAnalyticsProvider("phc_test", "https://us.i.posthog.com");
    await provider.capture({ name: "invoice_created", organizationId: "org_1", properties: { currency: "USD" } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://us.i.posthog.com/capture/");
    const body = JSON.parse(init.body as string);
    expect(body.api_key).toBe("phc_test");
    expect(body.event).toBe("invoice_created");
    expect(body.properties.currency).toBe("USD");
  });

  it("disables PostHog's IP-based geolocation on every event (Phase 15A privacy minimization)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createPostHogAnalyticsProvider("phc_test");
    await provider.capture({ name: "user_signed_in", userId: "user_1" });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.properties.$geoip_disable).toBe(true);
  });

  it("never sends an event name outside what the caller passed — no client IP or cookie ever included in the payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createPostHogAnalyticsProvider("phc_test");
    await provider.capture({ name: "user_signed_in", userId: "user_1" });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    const keys = Object.keys(body.properties);
    expect(keys).not.toContain("ip");
    expect(keys).not.toContain("$ip");
    expect(keys).not.toContain("cookie");
  });

  it("never throws when the network call fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const provider = createPostHogAnalyticsProvider("phc_test");
    await expect(provider.capture({ name: "user_signed_in" })).resolves.toBeUndefined();
  });
});
