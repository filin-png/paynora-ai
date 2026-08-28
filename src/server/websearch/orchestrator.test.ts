import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestOrganization } from "@/server/ar/test-fixtures";
import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { createFakeWebSearchProvider } from "./providers/fake";
import { decideAndSearch } from "./orchestrator";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const SEARCH_RESULT = { answer: "It's 2026.", citations: [{ title: "Example", url: "https://example.com", domain: "example.com" }], searchesUsed: 1 };

describe("decideAndSearch", () => {
  it("performs a real search when the AI decides one is needed", async () => {
    const { organization } = await createTestOrganization();
    const provider = createFakeWebSearchProvider({ kind: "success", result: SEARCH_RESULT });

    const result = await decideAndSearch(
      organization.id,
      "what year is it",
      {},
      {
        enabled: true,
        resolve: () => provider,
        decide: async () => ({ data: { needsSearch: true }, provider: "fake" }),
      },
    );

    expect(result).toEqual(SEARCH_RESULT);
  });

  it("returns the model's own direct answer, with no citations, when the AI decides search isn't needed", async () => {
    const { organization } = await createTestOrganization();

    const result = await decideAndSearch(
      organization.id,
      "what is 2 + 2",
      {},
      {
        decide: async () => ({ data: { needsSearch: false, directAnswer: "4" }, provider: "fake" }),
        resolve: () => {
          throw new Error("must never call the search provider when needsSearch is false");
        },
      },
    );

    expect(result).toEqual({ answer: "4", citations: [], searchesUsed: 0 });
  });

  it("returns null when the AI is unavailable to decide — never blindly searches or answers", async () => {
    const { organization } = await createTestOrganization();

    const result = await decideAndSearch(
      organization.id,
      "query",
      {},
      {
        decide: async () => null,
        resolve: () => {
          throw new Error("must never call the search provider when the decision is unavailable");
        },
      },
    );

    expect(result).toBeNull();
  });

  it("returns null (never a stale fallback answer) when search was needed but the search itself fails", async () => {
    const { organization } = await createTestOrganization();
    const provider = createFakeWebSearchProvider({ kind: "error", message: "provider down" });

    const result = await decideAndSearch(
      organization.id,
      "query",
      {},
      {
        enabled: true,
        resolve: () => provider,
        decide: async () => ({ data: { needsSearch: true }, provider: "fake" }),
      },
    );

    expect(result).toBeNull();
  });

  it("never calls the AI decision step once the organization's AI generation quota is exhausted", async () => {
    const { organization } = await createTestOrganization();
    // FREE plan's monthly AI-generation quota (see src/server/billing/plans.ts) — exhaust it directly
    // via the same rate-limit scope checkAiGenerationQuota itself uses.
    const { checkAiGenerationQuota } = await import("@/server/billing/entitlements");
    for (let i = 0; i < 20; i++) {
      await checkAiGenerationQuota(organization.id);
    }

    const result = await decideAndSearch(
      organization.id,
      "query",
      {},
      {
        decide: async () => {
          throw new Error("must never be called once the AI generation quota is exhausted");
        },
      },
    );

    expect(result).toBeNull();
  });
});
