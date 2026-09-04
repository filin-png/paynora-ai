import { describe, expect, it } from "vitest";

import { POST } from "./route";

function request(): Request {
  return new Request("http://localhost/api/webhooks/billing", {
    method: "POST",
    headers: { "x-billing-signature": "irrelevant" },
    body: "{}",
  });
}

describe("POST /api/webhooks/billing", () => {
  it("returns 503 when no billing provider is configured (the default, BILLING_PROVIDER=none)", async () => {
    const response = await POST(request());
    expect(response.status).toBe(503);
  });
});
