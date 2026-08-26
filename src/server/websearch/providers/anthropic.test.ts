import { afterEach, describe, expect, it, vi } from "vitest";

import { WebSearchProviderError } from "../errors";
import { createAnthropicWebSearchProvider } from "./anthropic";

describe("createAnthropicWebSearchProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the query as the user message with the web_search tool and max_uses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "answer" }], usage: { server_tool_use: { web_search_requests: 1 } } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createAnthropicWebSearchProvider("sk-test", "claude-opus-5");
    await provider.search({ query: "latest B2B SaaS trends", maxUses: 3 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-test");
    const body = JSON.parse(init.body as string);
    expect(body.tools[0]).toMatchObject({ type: "web_search_20250305", name: "web_search", max_uses: 3 });
    expect(body.messages[0].content).toBe("latest B2B SaaS trends");
  });

  it("extracts deduplicated citations from text blocks and never fabricates a domain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: "Answer with a source.",
              citations: [
                { type: "web_search_result_location", url: "https://example.com/a", title: "Example A", cited_text: "..." },
                { type: "web_search_result_location", url: "https://example.com/a", title: "Example A", cited_text: "..." },
              ],
            },
          ],
          usage: { server_tool_use: { web_search_requests: 1 } },
        }),
      }),
    );

    const provider = createAnthropicWebSearchProvider("sk-test", "claude-opus-5");
    const result = await provider.search({ query: "x", maxUses: 1 });

    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({ url: "https://example.com/a", domain: "example.com" });
    expect(result.searchesUsed).toBe(1);
  });

  it("throws WebSearchProviderError on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { message: "invalid x-api-key" } }) }),
    );
    const provider = createAnthropicWebSearchProvider("bad-key", "claude-opus-5");
    await expect(provider.search({ query: "x", maxUses: 1 })).rejects.toBeInstanceOf(WebSearchProviderError);
  });
});
