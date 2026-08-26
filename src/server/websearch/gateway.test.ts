import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { webSearchPolicy } from "@/server/rate-limit/policies";
import { checkRateLimit } from "@/server/rate-limit/service";
import { createFakeWebSearchProvider } from "./providers/fake";
import { MAX_SEARCHES_PER_CALL, tryWebSearch } from "./gateway";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const SUCCESS_RESULT = { answer: "Answer.", citations: [], searchesUsed: 1 };

describe("tryWebSearch", () => {
  it("returns null when web search is disabled", async () => {
    const { organization } = await createTestOrganization();
    const result = await tryWebSearch(organization.id, "query", {}, { enabled: false });
    expect(result).toBeNull();
  });

  it("returns the provider's result when enabled and successful", async () => {
    const { organization } = await createTestOrganization();
    const provider = createFakeWebSearchProvider({ kind: "success", result: SUCCESS_RESULT });

    const result = await tryWebSearch(organization.id, "query", {}, { enabled: true, resolve: () => provider });

    expect(result).toEqual(SUCCESS_RESULT);
  });

  it("caps maxUses at MAX_SEARCHES_PER_CALL even if a caller asks for more", async () => {
    const { organization } = await createTestOrganization();
    let capturedMaxUses = 0;
    const provider = {
      name: "spy",
      async search(request: { maxUses: number }) {
        capturedMaxUses = request.maxUses;
        return SUCCESS_RESULT;
      },
    };

    await tryWebSearch(organization.id, "query", { maxUses: 999 }, { enabled: true, resolve: () => provider });

    expect(capturedMaxUses).toBe(MAX_SEARCHES_PER_CALL);
  });

  it("returns null instead of throwing when the provider errors", async () => {
    const { organization } = await createTestOrganization();
    const provider = createFakeWebSearchProvider({ kind: "error", message: "provider down" });

    const result = await tryWebSearch(organization.id, "query", {}, { enabled: true, resolve: () => provider });

    expect(result).toBeNull();
  });

  it("never calls the provider once the hourly rate limit is exhausted", async () => {
    const { organization } = await createTestOrganization();
    const policy = webSearchPolicy();
    for (let i = 0; i < policy.maxAttempts; i++) {
      await checkRateLimit("web-search", organization.id, policy);
    }

    const result = await tryWebSearch(
      organization.id,
      "query",
      {},
      {
        enabled: true,
        resolve: () => {
          throw new Error("must never be called once the rate limit is exhausted");
        },
      },
    );

    expect(result).toBeNull();
  }, 20000);
});
