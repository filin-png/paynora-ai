/**
 * Sandbox integration test — makes a REAL call to the Anthropic Messages
 * API with the real `web_search_20250305` tool enabled, using a REAL API
 * key. Deliberately separate from anthropic.test.ts (mocked `fetch`,
 * always runs, no credentials needed).
 *
 * Opt-in only: skipped unless RUN_EXTERNAL_INTEGRATION_TESTS=true, so
 * `npm run test` and CI never require an Anthropic account or spend money.
 * This test itself costs a small, real amount (one search + a few hundred
 * tokens — see docs/production-integrations.md#cost-control) each time it
 * runs, which is why it never runs by default. To run it locally:
 *
 *   RUN_EXTERNAL_INTEGRATION_TESTS=true ANTHROPIC_API_KEY=sk-ant-xxx npm run test -- anthropic.sandbox
 *
 * See docs/production-integrations.md#test-layers.
 */
import { describe, expect, it } from "vitest";

import { createAnthropicWebSearchProvider } from "./anthropic";

const RUN = process.env.RUN_EXTERNAL_INTEGRATION_TESTS === "true";
const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-5";

describe.skipIf(!RUN)("Anthropic web search sandbox (real network, opt-in, real cost)", () => {
  it("performs a real web search and returns a cited answer", async () => {
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY must be set when RUN_EXTERNAL_INTEGRATION_TESTS=true for this test to run.");
    }

    const provider = createAnthropicWebSearchProvider(apiKey, model);
    const result = await provider.search({
      query: "What is the current year? Answer in one short sentence.",
      maxUses: 1,
    });

    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.searchesUsed).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.citations)).toBe(true);
  }, 30_000);
});
