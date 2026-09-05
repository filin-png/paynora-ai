import { describe, expect, it } from "vitest";

import { extractSourceIp, POST } from "./route";

function request(headers: Record<string, string> = { "x-billing-signature": "irrelevant" }): Request {
  return new Request("http://localhost/api/webhooks/billing", {
    method: "POST",
    headers,
    body: "{}",
  });
}

describe("POST /api/webhooks/billing", () => {
  it("returns 503 when no billing provider is configured (the default, BILLING_PROVIDER=none)", async () => {
    const response = await POST(request());
    expect(response.status).toBe(503);
  });

  it("returns 503 for any header shape while billing is disabled — never reaches provider verification", async () => {
    const response = await POST(
      request({ "x-billing-signature": "irrelevant", "x-real-ip": "185.71.76.5", "x-forwarded-for": "1.2.3.4" }),
    );
    expect(response.status).toBe(503);
  });
});

describe("extractSourceIp", () => {
  it("prefers x-real-ip when present", () => {
    const req = request({ "x-real-ip": "185.71.76.5", "x-forwarded-for": "9.9.9.9, 1.2.3.4" });
    expect(extractSourceIp(req)).toBe("185.71.76.5");
  });

  it("falls back to the first hop of x-forwarded-for when x-real-ip is absent", () => {
    const req = request({ "x-forwarded-for": "185.71.76.5, 10.0.0.1" });
    expect(extractSourceIp(req)).toBe("185.71.76.5");
  });

  it("returns undefined when neither header is present", () => {
    const req = request({});
    expect(extractSourceIp(req)).toBeUndefined();
  });
});
