import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// See openrouter.test.ts for why this module is mocked rather than
// mutating `process.env` directly — `@/lib/env`'s `env` is a singleton
// parsed once at startup.
vi.mock("@/lib/env", () => ({
  env: { MISTRAL_API_KEY: undefined, MISTRAL_MODEL: undefined },
}));

import { env } from "@/lib/env";
import { createMistralProvider } from "./mistral";

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
  (env as { MISTRAL_API_KEY?: string }).MISTRAL_API_KEY = undefined;
  (env as { MISTRAL_MODEL?: string }).MISTRAL_MODEL = undefined;
});

describe("Mistral adapter (mocked fetch — no real network, no real key)", () => {
  it("refuses to call the network when unconfigured", async () => {
    const fetchImpl = vi.fn();
    const provider = createMistralProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/MISTRAL_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the correct URL, headers, and OpenAI-compatible request body; parses a successful response including usage", async () => {
    (env as { MISTRAL_API_KEY?: string }).MISTRAL_API_KEY = "test-key";
    (env as { MISTRAL_MODEL?: string }).MISTRAL_MODEL = "test-model";

    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({ answer: "4" }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }),
    );

    const provider = createMistralProvider(fetchImpl);
    const result = await provider.generateStructured(request);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mistral.ai/v1/chat/completions");
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
    expect(result.provider).toBe("mistral");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 3 });
  });

  it("on a non-OK HTTP response, throws an error containing only the status code — never the API key or response body", async () => {
    (env as { MISTRAL_API_KEY?: string }).MISTRAL_API_KEY = "super-secret-key";
    (env as { MISTRAL_MODEL?: string }).MISTRAL_MODEL = "test-model";

    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: "secret-leaking-body should never appear in the thrown message" },
        { ok: false, status: 401 },
      ),
    );

    const provider = createMistralProvider(fetchImpl);
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
    (env as { MISTRAL_API_KEY?: string }).MISTRAL_API_KEY = "test-key";
    (env as { MISTRAL_MODEL?: string }).MISTRAL_MODEL = "test-model";

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: {} }] }));
    const provider = createMistralProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/did not include message content/);
  });
});
