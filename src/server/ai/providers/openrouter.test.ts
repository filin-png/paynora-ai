import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// The provider module reads `env.OPENROUTER_API_KEY`/`env.OPENROUTER_MODEL`
// from the real `@/lib/env` singleton, which is parsed once at process
// startup from `process.env` — mutating `process.env` after that point has
// no effect on it (see src/lib/env.ts: `export const env = parseEnv();`).
// To exercise both the "not configured" and "configured" paths without a
// real credential, this file mocks the module itself and mutates the
// mocked object's fields per test — isolated to this test file only, never
// touching the real singleton other test files rely on.
vi.mock("@/lib/env", () => ({
  env: { OPENROUTER_API_KEY: undefined, OPENROUTER_MODEL: undefined },
}));

import { env } from "@/lib/env";
import { createOpenRouterProvider } from "./openrouter";

const schema = z.object({ answer: z.string() });
const request = { system: "be helpful", input: { question: "2+2" }, schema };

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  (env as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY = undefined;
  (env as { OPENROUTER_MODEL?: string }).OPENROUTER_MODEL = undefined;
});

describe("OpenRouter adapter (mocked fetch — no real network, no real key)", () => {
  it("refuses to call the network when unconfigured", async () => {
    const fetchImpl = vi.fn();
    const provider = createOpenRouterProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the correct URL, headers, and OpenAI-compatible request body; parses a successful response including usage", async () => {
    (env as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY = "test-key";
    (env as { OPENROUTER_MODEL?: string }).OPENROUTER_MODEL = "test-model";

    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({ answer: "4" }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }),
    );

    const provider = createOpenRouterProvider(fetchImpl);
    const result = await provider.generateStructured(request);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers["content-type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("test-model");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1]).toEqual({ role: "user", content: JSON.stringify(request.input) });

    expect(result.data).toEqual({ answer: "4" });
    expect(result.provider).toBe("openrouter");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 3 });
  });

  it("on a non-OK HTTP response, throws an error containing only the status code — never the API key or response body", async () => {
    (env as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY = "super-secret-key";
    (env as { OPENROUTER_MODEL?: string }).OPENROUTER_MODEL = "test-model";

    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: "secret-leaking-body should never appear in the thrown message" },
        { ok: false, status: 401 },
      ),
    );

    const provider = createOpenRouterProvider(fetchImpl);
    let caught: unknown;
    try {
      await provider.generateStructured(request);
    } catch (error) {
      caught = error;
    }

    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("HTTP 401");
    expect(message).not.toContain("super-secret-key");
    expect(message).not.toContain("secret-leaking-body");
  });

  it("throws when the response body is missing message content", async () => {
    (env as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY = "test-key";
    (env as { OPENROUTER_MODEL?: string }).OPENROUTER_MODEL = "test-model";

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: {} }] }));
    const provider = createOpenRouterProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/did not include message content/);
  });
});
