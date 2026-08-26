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

  it("never throws when the network call fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const provider = createPostHogAnalyticsProvider("phc_test");
    await expect(provider.capture({ name: "user_signed_in" })).resolves.toBeUndefined();
  });
});
