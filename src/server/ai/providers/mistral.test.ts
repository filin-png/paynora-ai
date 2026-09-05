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

  it("classifies HTTP 429 as 'rate limited' — never the API key or response body", async () => {
    (env as { MISTRAL_API_KEY?: string }).MISTRAL_API_KEY = "super-secret-key";
    (env as { MISTRAL_MODEL?: string }).MISTRAL_MODEL = "test-model";

    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: "monthly token cap exceeded — never appears in the thrown message" }, { ok: false, status: 429 }),
    );
    const provider = createMistralProvider(fetchImpl);

    let caught: unknown;
    try {
      await provider.generateStructured(request);
    } catch (error) {
      caught = error;
    }

    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("HTTP 429");
    expect(message).toContain("rate limited");
    expect(message).not.toContain("super-secret-key");
    expect(message).not.toContain("monthly token cap");
  });

  it("classifies a Mistral 5xx (transient server error) as 'provider error' — never the API key or response body", async () => {
    (env as { MISTRAL_API_KEY?: string }).MISTRAL_API_KEY = "super-secret-key";
    (env as { MISTRAL_MODEL?: string }).MISTRAL_MODEL = "test-model";

    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: "internal error detail should never appear in the thrown message" }, { ok: false, status: 503 }),
    );
    const provider = createMistralProvider(fetchImpl);

    let caught: unknown;
    try {
      await provider.generateStructured(request);
    } catch (error) {
      caught = error;
    }

    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("HTTP 503");
    expect(message).toContain("provider error");
    expect(message).not.toContain("super-secret-key");
    expect(message).not.toContain("internal error detail");
  });

  it("classifies HTTP 403 (e.g. a guardrail/moderation block) as 'authentication failed' — the same bucket as 401", async () => {
    (env as { MISTRAL_API_KEY?: string }).MISTRAL_API_KEY = "test-key";
    (env as { MISTRAL_MODEL?: string }).MISTRAL_MODEL = "test-model";

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 403 }));
    const provider = createMistralProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/HTTP 403.*authentication failed/);
  });

  it("propagates a real network failure (e.g. DNS/connection error) without ever including the API key", async () => {
    (env as { MISTRAL_API_KEY?: string }).MISTRAL_API_KEY = "super-secret-key";
    (env as { MISTRAL_MODEL?: string }).MISTRAL_MODEL = "test-model";

    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed: getaddrinfo ENOTFOUND api.mistral.ai"));
    const provider = createMistralProvider(fetchImpl);

    let caught: unknown;
    try {
      await provider.generateStructured(request);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain("super-secret-key");
  });

  it("forwards request.maxOutputTokens as the wire-level max_tokens field", async () => {
    (env as { MISTRAL_API_KEY?: string }).MISTRAL_API_KEY = "test-key";
    (env as { MISTRAL_MODEL?: string }).MISTRAL_MODEL = "test-model";

    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: JSON.stringify({ answer: "4" }) } }] }),
    );
    const provider = createMistralProvider(fetchImpl);

    await provider.generateStructured({ ...request, maxOutputTokens: 500 });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(500);
  });

  it("handles concurrent calls independently — each gets its own request/response, no shared mutable state", async () => {
    (env as { MISTRAL_API_KEY?: string }).MISTRAL_API_KEY = "test-key";
    (env as { MISTRAL_MODEL?: string }).MISTRAL_MODEL = "test-model";

    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages: { content: string }[] };
      const parsedInput = JSON.parse(body.messages[1]!.content) as { question: string };
      // Echoes the input back so each concurrent call's response can be
      // proven to correspond to its own request, not a mixed-up one.
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ answer: parsedInput.question }) } }],
      });
    });
    const provider = createMistralProvider(fetchImpl);

    const [a, b, c] = await Promise.all([
      provider.generateStructured({ ...request, input: { question: "first" } }),
      provider.generateStructured({ ...request, input: { question: "second" } }),
      provider.generateStructured({ ...request, input: { question: "third" } }),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(a.data).toEqual({ answer: "first" });
    expect(b.data).toEqual({ answer: "second" });
    expect(c.data).toEqual({ answer: "third" });
  });
});
