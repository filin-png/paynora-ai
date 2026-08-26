import { beforeEach, describe, expect, it } from "vitest";

import { createTestOrganization } from "@/server/ar/test-fixtures";
import { resetDatabase } from "@/server/db/test-utils";
import { POST } from "./route";

beforeEach(async () => {
  await resetDatabase();
});

function request(): Request {
  return new Request("http://localhost/api/webhooks/wallet/some-org", {
    method: "POST",
    headers: { "x-alchemy-signature": "irrelevant" },
    body: "{}",
  });
}

describe("POST /api/webhooks/wallet/[orgSlug]", () => {
  it("returns 404 for an unknown organization slug, before ever touching the wallet provider", async () => {
    const response = await POST(request(), { params: Promise.resolve({ orgSlug: "does-not-exist" }) });
    expect(response.status).toBe(404);
  });

  it("returns 503 when no wallet provider is configured for a real organization (the default, WALLET_PROVIDER=none)", async () => {
    const { organization } = await createTestOrganization();
    const response = await POST(request(), { params: Promise.resolve({ orgSlug: organization.slug }) });
    expect(response.status).toBe(503);
  });
});
