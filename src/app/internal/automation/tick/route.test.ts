import { beforeEach, describe, expect, it } from "vitest";

import { env } from "@/lib/env";
import { resetDatabase } from "@/server/db/test-utils";
import { createAutomationReadyOrg, createTestInvoice } from "@/server/collections/test-fixtures";
import { POST } from "./route";

beforeEach(async () => {
  await resetDatabase();
});

function request(authorization?: string): Request {
  return new Request("http://localhost/internal/automation/tick", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });
}

describe("POST /internal/automation/tick", () => {
  it("rejects a request with no Authorization header", async () => {
    const response = await POST(request());
    expect(response.status).toBe(401);
  });

  it("rejects a request with the wrong secret", async () => {
    const response = await POST(request("Bearer wrong-secret"));
    expect(response.status).toBe(401);
  });

  it("accepts a request with the configured secret and runs a global tick", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    await createTestInvoice(organization.id, customer.id, "2020-01-01");

    const response = await POST(request(`Bearer ${env.AUTOMATION_CRON_SECRET}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { summary: { organizationsProcessed: number; enrolled: number } };
    expect(body.summary.organizationsProcessed).toBeGreaterThanOrEqual(1);
    expect(body.summary.enrolled).toBeGreaterThanOrEqual(1);
  });

  it("never reads a tenant id from the request body — the tick is always global", async () => {
    const { organization, customer } = await createAutomationReadyOrg("Alpha");
    await createTestInvoice(organization.id, customer.id, "2020-01-01");
    const other = await createAutomationReadyOrg("Bravo");
    await createTestInvoice(other.organization.id, other.customer.id, "2020-01-01");

    const result = await POST(
      new Request("http://localhost/internal/automation/tick", {
        method: "POST",
        headers: { authorization: `Bearer ${env.AUTOMATION_CRON_SECRET}`, "content-type": "application/json" },
        body: JSON.stringify({ organizationId: organization.id }),
      }),
    );
    const body = (await result.json()) as { summary: { organizationsProcessed: number } };
    // Both organizations get processed regardless of the (ignored) body.
    expect(body.summary.organizationsProcessed).toBeGreaterThanOrEqual(2);
  });

  it("never reads a forged `now` from the request body — the tick always uses the real server clock", async () => {
    const { organization, customer } = await createAutomationReadyOrg();
    // Due a few days from today (real clock) — not overdue yet under the
    // real clock, but would be *years* overdue under a forged 2099 `now`,
    // which would force every catch-up step to fire at once if the body
    // were trusted.
    const notYetDue = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await createTestInvoice(organization.id, customer.id, notYetDue);

    const result = await POST(
      new Request("http://localhost/internal/automation/tick", {
        method: "POST",
        headers: { authorization: `Bearer ${env.AUTOMATION_CRON_SECRET}`, "content-type": "application/json" },
        body: JSON.stringify({ now: "2099-01-01T00:00:00.000Z" }),
      }),
    );
    const body = (await result.json()) as { summary: { executed: number; enrolled: number } };
    expect(body.summary.enrolled).toBeGreaterThanOrEqual(1); // enrollment doesn't require overdue
    expect(body.summary.executed).toBe(0); // but nothing is due yet under the real clock
  });

  it("rejects a malformed Authorization header (no Bearer prefix)", async () => {
    const response = await POST(request(env.AUTOMATION_CRON_SECRET));
    expect(response.status).toBe(401);
  });

  it("does not echo the configured secret back in any response body", async () => {
    const unauthorized = await POST(request("Bearer wrong-secret"));
    const unauthorizedText = await unauthorized.text();
    expect(unauthorizedText).not.toContain(env.AUTOMATION_CRON_SECRET);

    const { organization, customer } = await createAutomationReadyOrg();
    await createTestInvoice(organization.id, customer.id, "2020-01-01");
    const ok = await POST(request(`Bearer ${env.AUTOMATION_CRON_SECRET}`));
    const okText = await ok.text();
    expect(okText).not.toContain(env.AUTOMATION_CRON_SECRET!);
  });
});
