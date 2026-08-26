import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { runDeepResearch } from "./deep-research";
import { MAX_SEARCHES_PER_CALL } from "./gateway";
import { createFakeWebSearchProvider } from "./providers/fake";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

describe("runDeepResearch", () => {
  it("returns null when disabled", async () => {
    const { organization } = await createTestOrganization();
    const result = await runDeepResearch(organization.id, "research query", { enabled: false });
    expect(result).toBeNull();
  });

  it("requests the maximum allowed searches, never more", async () => {
    const { organization } = await createTestOrganization();
    let captured = 0;
    const provider = {
      name: "spy",
      async search(request: { maxUses: number }) {
        captured = request.maxUses;
        return { answer: "synthesized", citations: [], searchesUsed: request.maxUses };
      },
    };

    await runDeepResearch(organization.id, "research query", { enabled: true, resolve: () => provider });

    expect(captured).toBe(MAX_SEARCHES_PER_CALL);
  });

  it("returns null instead of hanging forever when the provider never resolves", async () => {
    const { organization } = await createTestOrganization();
    const provider = createFakeWebSearchProvider({ kind: "hang" });

    const result = await runDeepResearch(organization.id, "research query", {
      enabled: true,
      resolve: () => provider,
      timeoutMs: 50,
    });

    expect(result).toBeNull();
  });
});
