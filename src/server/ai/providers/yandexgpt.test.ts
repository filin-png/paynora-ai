import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// See openrouter.test.ts for why this module is mocked rather than
// mutating `process.env` directly — `@/lib/env`'s `env` is a singleton
// parsed once at startup.
vi.mock("@/lib/env", () => ({
  env: { YANDEXGPT_API_KEY: undefined, YANDEXGPT_MODEL: undefined, YANDEXGPT_FOLDER_ID: undefined },
}));

import { env } from "@/lib/env";
import { createYandexGptProvider } from "./yandexgpt";

const schema = z.object({ answer: z.string() });
const request = { system: "be helpful", input: { question: "2+2" }, schema };

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

function completionResponse(answer = "4", usage?: { inputTextTokens: string; completionTokens: string }) {
  return jsonResponse({
    result: {
      alternatives: [{ message: { role: "assistant", text: JSON.stringify({ answer }) } }],
      ...(usage ? { usage } : {}),
    },
  });
}

beforeEach(() => {
  (env as { YANDEXGPT_API_KEY?: string }).YANDEXGPT_API_KEY = undefined;
  (env as { YANDEXGPT_MODEL?: string }).YANDEXGPT_MODEL = undefined;
  (env as { YANDEXGPT_FOLDER_ID?: string }).YANDEXGPT_FOLDER_ID = undefined;
});

describe("YandexGPT adapter (mocked fetch — no real network, no real key)", () => {
  it("refuses to call the network when unconfigured", async () => {
    const fetchImpl = vi.fn();
    const provider = createYandexGptProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/YANDEXGPT_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the correct URL, headers, and request body; parses a successful response including usage", async () => {
    (env as { YANDEXGPT_API_KEY?: string }).YANDEXGPT_API_KEY = "test-key";
    (env as { YANDEXGPT_MODEL?: string }).YANDEXGPT_MODEL = "yandexgpt/latest";
    (env as { YANDEXGPT_FOLDER_ID?: string }).YANDEXGPT_FOLDER_ID = "b1gfolder123";

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(completionResponse("4", { inputTextTokens: "10", completionTokens: "3" }));

    const provider = createYandexGptProvider(fetchImpl);
    const result = await provider.generateStructured(request);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.api.cloud.yandex.net/foundationModels/v1/completion");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Api-Key test-key");
    expect(headers["x-folder-id"]).toBe("b1gfolder123");

    const body = JSON.parse(init.body as string);
    expect(body.modelUri).toBe("gpt://b1gfolder123/yandexgpt/latest");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1]).toEqual({ role: "user", text: JSON.stringify(request.input) });

    expect(result.data).toEqual({ answer: "4" });
    expect(result.provider).toBe("yandex");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 3 });
  });

  it("on a non-OK HTTP response, throws an error containing only the status code — never the API key or response body", async () => {
    (env as { YANDEXGPT_API_KEY?: string }).YANDEXGPT_API_KEY = "super-secret-key";
    (env as { YANDEXGPT_MODEL?: string }).YANDEXGPT_MODEL = "yandexgpt/latest";
    (env as { YANDEXGPT_FOLDER_ID?: string }).YANDEXGPT_FOLDER_ID = "b1gfolder123";

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: "secret-leaking-body should never appear" }, { ok: false, status: 401 }));

    const provider = createYandexGptProvider(fetchImpl);
    let caught: unknown;
    try {
      await provider.generateStructured(request);
    } catch (error) {
      caught = error;
    }

    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("HTTP 401");
    expect(message).toContain("authentication failed");
    expect(message).not.toContain("super-secret-key");
    expect(message).not.toContain("secret-leaking-body");
  });

  it("classifies HTTP 429 as 'rate limited'", async () => {
    (env as { YANDEXGPT_API_KEY?: string }).YANDEXGPT_API_KEY = "test-key";
    (env as { YANDEXGPT_MODEL?: string }).YANDEXGPT_MODEL = "yandexgpt/latest";
    (env as { YANDEXGPT_FOLDER_ID?: string }).YANDEXGPT_FOLDER_ID = "b1gfolder123";

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 429 }));
    const provider = createYandexGptProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/HTTP 429.*rate limited/);
  });

  it("classifies a 5xx as 'provider error'", async () => {
    (env as { YANDEXGPT_API_KEY?: string }).YANDEXGPT_API_KEY = "test-key";
    (env as { YANDEXGPT_MODEL?: string }).YANDEXGPT_MODEL = "yandexgpt/latest";
    (env as { YANDEXGPT_FOLDER_ID?: string }).YANDEXGPT_FOLDER_ID = "b1gfolder123";

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 503 }));
    const provider = createYandexGptProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/HTTP 503.*provider error/);
  });

  it("classifies HTTP 400 as 'request rejected'", async () => {
    (env as { YANDEXGPT_API_KEY?: string }).YANDEXGPT_API_KEY = "test-key";
    (env as { YANDEXGPT_MODEL?: string }).YANDEXGPT_MODEL = "yandexgpt/latest";
    (env as { YANDEXGPT_FOLDER_ID?: string }).YANDEXGPT_FOLDER_ID = "b1gfolder123";

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 400 }));
    const provider = createYandexGptProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/HTTP 400.*request rejected/);
  });

  it("classifies HTTP 403 as 'authentication failed' — the same bucket as 401", async () => {
    (env as { YANDEXGPT_API_KEY?: string }).YANDEXGPT_API_KEY = "test-key";
    (env as { YANDEXGPT_MODEL?: string }).YANDEXGPT_MODEL = "yandexgpt/latest";
    (env as { YANDEXGPT_FOLDER_ID?: string }).YANDEXGPT_FOLDER_ID = "b1gfolder123";

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 403 }));
    const provider = createYandexGptProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/HTTP 403.*authentication failed/);
  });

  it("throws when the response body is missing message text", async () => {
    (env as { YANDEXGPT_API_KEY?: string }).YANDEXGPT_API_KEY = "test-key";
    (env as { YANDEXGPT_MODEL?: string }).YANDEXGPT_MODEL = "yandexgpt/latest";
    (env as { YANDEXGPT_FOLDER_ID?: string }).YANDEXGPT_FOLDER_ID = "b1gfolder123";

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ result: { alternatives: [{ message: {} }] } }));
    const provider = createYandexGptProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/did not include message text/);
  });

  it("throws when the response body is not valid JSON", async () => {
    (env as { YANDEXGPT_API_KEY?: string }).YANDEXGPT_API_KEY = "test-key";
    (env as { YANDEXGPT_MODEL?: string }).YANDEXGPT_MODEL = "yandexgpt/latest";
    (env as { YANDEXGPT_FOLDER_ID?: string }).YANDEXGPT_FOLDER_ID = "b1gfolder123";

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);
    const provider = createYandexGptProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/response was not valid JSON/);
  });

  it("throws when the message text is not valid JSON", async () => {
    (env as { YANDEXGPT_API_KEY?: string }).YANDEXGPT_API_KEY = "test-key";
    (env as { YANDEXGPT_MODEL?: string }).YANDEXGPT_MODEL = "yandexgpt/latest";
    (env as { YANDEXGPT_FOLDER_ID?: string }).YANDEXGPT_FOLDER_ID = "b1gfolder123";

    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ result: { alternatives: [{ message: { text: "not json" } }] } }),
    );
    const provider = createYandexGptProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/response content was not valid JSON/);
  });

  it("propagates a real network failure (e.g. DNS/connection error) without ever including the API key", async () => {
    (env as { YANDEXGPT_API_KEY?: string }).YANDEXGPT_API_KEY = "super-secret-key";
    (env as { YANDEXGPT_MODEL?: string }).YANDEXGPT_MODEL = "yandexgpt/latest";
    (env as { YANDEXGPT_FOLDER_ID?: string }).YANDEXGPT_FOLDER_ID = "b1gfolder123";

    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed: getaddrinfo ENOTFOUND llm.api.cloud.yandex.net"));
    const provider = createYandexGptProvider(fetchImpl);

    let caught: unknown;
    try {
      await provider.generateStructured(request);
    } catch (error) {
      caught = error;
    }

    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("network error");
    expect(message).not.toContain("super-secret-key");
  });

  it("forwards request.maxOutputTokens as the wire-level maxTokens field, serialized as a string", async () => {
    (env as { YANDEXGPT_API_KEY?: string }).YANDEXGPT_API_KEY = "test-key";
    (env as { YANDEXGPT_MODEL?: string }).YANDEXGPT_MODEL = "yandexgpt/latest";
    (env as { YANDEXGPT_FOLDER_ID?: string }).YANDEXGPT_FOLDER_ID = "b1gfolder123";

    const fetchImpl = vi.fn().mockResolvedValue(completionResponse());
    const provider = createYandexGptProvider(fetchImpl);

    await provider.generateStructured({ ...request, maxOutputTokens: 500 });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.completionOptions.maxTokens).toBe("500");
  });

  it("omits maxTokens entirely when maxOutputTokens is not set", async () => {
    (env as { YANDEXGPT_API_KEY?: string }).YANDEXGPT_API_KEY = "test-key";
    (env as { YANDEXGPT_MODEL?: string }).YANDEXGPT_MODEL = "yandexgpt/latest";
    (env as { YANDEXGPT_FOLDER_ID?: string }).YANDEXGPT_FOLDER_ID = "b1gfolder123";

    const fetchImpl = vi.fn().mockResolvedValue(completionResponse());
    const provider = createYandexGptProvider(fetchImpl);

    await provider.generateStructured(request);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.completionOptions.maxTokens).toBeUndefined();
  });

  it("handles concurrent calls independently — each gets its own request/response, no shared mutable state", async () => {
    (env as { YANDEXGPT_API_KEY?: string }).YANDEXGPT_API_KEY = "test-key";
    (env as { YANDEXGPT_MODEL?: string }).YANDEXGPT_MODEL = "yandexgpt/latest";
    (env as { YANDEXGPT_FOLDER_ID?: string }).YANDEXGPT_FOLDER_ID = "b1gfolder123";

    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages: { text: string }[] };
      const parsedInput = JSON.parse(body.messages[1]!.text) as { question: string };
      return completionResponse(parsedInput.question);
    });
    const provider = createYandexGptProvider(fetchImpl);

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
