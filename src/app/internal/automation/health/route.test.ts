import { beforeEach, describe, expect, it } from "vitest";

import { env } from "@/lib/env";
import { resetDatabase } from "@/server/db/test-utils";
import { runAutomationTick } from "@/server/collections/engine";
import { createAutomationReadyOrg, createTestInvoice } from "@/server/collections/test-fixtures";
import { GET } from "./route";

beforeEach(async () => {
  await resetDatabase();
});

function request(authorization?: string): Request {
  return new Request("http://localhost/internal/automation/health", {
    method: "GET",
    headers: authorization ? { authorization } : {},
  });
}

describe("GET /internal/automation/health", () => {
  it("rejects a request with no Authorization header", async () => {
    const response = await GET(request());
    expect(response.status).toBe(401);
  });

  it("rejects a request with the wrong secret", async () => {
    const response = await GET(request("Bearer wrong-secret"));
    expect(response.status).toBe(401);
  });

  it("rejects a malformed Authorization header (no Bearer prefix)", async () => {
    const response = await GET(request(env.AUTOMATION_CRON_SECRET));
    expect(response.status).toBe(401);
  });

  it("does not echo the configured secret back in any response body", async () => {
    const unauthorized = await GET(request("Bearer wrong-secret"));
    expect(await unauthorized.text()).not.toContain(env.AUTOMATION_CRON_SECRET);
  });

  it("returns HTTP 503 (not ready) when automation is enabled but no tick has ever run", async () => {
    const response = await GET(request(`Bearer ${env.AUTOMATION_CRON_SECRET}`));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { live: boolean; ready: boolean };
    expect(body.live).toBe(true);
    expect(body.ready).toBe(false);
  });

  it("returns HTTP 200 (ready) after a real tick has run successfully", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    await createTestInvoice(organization.id, customer.id, "2020-01-01");
    await runAutomationTick(new Date());

    const response = await GET(request(`Bearer ${env.AUTOMATION_CRON_SECRET}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ready: boolean; lastTickAt: string | null };
    expect(body.ready).toBe(true);
    expect(body.lastTickAt).not.toBeNull();
  });

  it("never includes customer, invoice, or message data in the response — only counts and timestamps", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    await createTestInvoice(organization.id, customer.id, "2020-01-01");
    await runAutomationTick(new Date());

    const response = await GET(request(`Bearer ${env.AUTOMATION_CRON_SECRET}`));
    const text = await response.text();
    expect(text).not.toContain(customer.name);
    expect(text).not.toContain(organization.name);
  });
});
