import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// See openrouter.test.ts for why this module is mocked rather than
// mutating `process.env` directly — `@/lib/env`'s `env` is a singleton
// parsed once at startup.
vi.mock("@/lib/env", () => ({
  env: { GIGACHAT_API_KEY: undefined, GIGACHAT_MODEL: undefined, GIGACHAT_SCOPE: "GIGACHAT_API_PERS" },
}));

import { env } from "@/lib/env";
import { createGigaChatProvider } from "./gigachat";

const schema = z.object({ answer: z.string() });
const request = { system: "be helpful", input: { question: "2+2" }, schema };

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

function oauthResponse(accessToken = "test-access-token") {
  return jsonResponse({ access_token: accessToken, expires_at: Date.now() + 30 * 60 * 1000 });
}

function chatResponse(answer = "4") {
  return jsonResponse({ choices: [{ message: { content: JSON.stringify({ answer }) } }] });
}

beforeEach(() => {
  (env as { GIGACHAT_API_KEY?: string }).GIGACHAT_API_KEY = undefined;
  (env as { GIGACHAT_MODEL?: string }).GIGACHAT_MODEL = undefined;
});

describe("GigaChat adapter (mocked fetch — no real network, no real key)", () => {
  it("refuses to call the network when unconfigured", async () => {
    const fetchImpl = vi.fn();
    const provider = createGigaChatProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/GIGACHAT_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("exchanges the authorization key for an access token, then calls chat completions with it", async () => {
    (env as { GIGACHAT_API_KEY?: string }).GIGACHAT_API_KEY = "test-authorization-key";
    (env as { GIGACHAT_MODEL?: string }).GIGACHAT_MODEL = "GigaChat";

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(oauthResponse("fresh-access-token"))
      .mockResolvedValueOnce(chatResponse());

    const provider = createGigaChatProvider(fetchImpl);
    const result = await provider.generateStructured(request);

    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [oauthUrl, oauthInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(oauthUrl).toBe("https://ngw.devices.sberbank.ru:9443/api/v2/oauth");
    expect(oauthInit.method).toBe("POST");
    const oauthHeaders = oauthInit.headers as Record<string, string>;
    expect(oauthHeaders.authorization).toBe("Basic test-authorization-key");
    expect(oauthHeaders.RqUID).toBeTruthy();
    expect(oauthInit.body).toBe("scope=GIGACHAT_API_PERS");

    const [chatUrl, chatInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(chatUrl).toBe("https://api.giga.chat/v1/chat/completions");
    const chatHeaders = chatInit.headers as Record<string, string>;
    expect(chatHeaders.authorization).toBe("Bearer fresh-access-token");
    const body = JSON.parse(chatInit.body as string);
    expect(body.model).toBe("GigaChat");
    expect(body.response_format).toEqual({ type: "json_object" });

    expect(result.data).toEqual({ answer: "4" });
    expect(result.provider).toBe("gigachat");
  });

  it("reuses a cached access token across two calls without re-authenticating", async () => {
    (env as { GIGACHAT_API_KEY?: string }).GIGACHAT_API_KEY = "test-authorization-key";
    (env as { GIGACHAT_MODEL?: string }).GIGACHAT_MODEL = "GigaChat";

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(oauthResponse("token-1"))
      .mockResolvedValueOnce(chatResponse("first"))
      .mockResolvedValueOnce(chatResponse("second"));

    const provider = createGigaChatProvider(fetchImpl);
    const first = await provider.generateStructured(request);
    const second = await provider.generateStructured(request);

    // Exactly 3 calls total: one oauth exchange + two chat completions —
    // the second generateStructured call must not re-authenticate.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(first.data).toEqual({ answer: "first" });
    expect(second.data).toEqual({ answer: "second" });
    const [, secondChatInit] = fetchImpl.mock.calls[2] as [string, RequestInit];
    const secondHeaders = secondChatInit.headers as Record<string, string>;
    expect(secondHeaders.authorization).toBe("Bearer token-1");
  });

  it("does not share a cached token between two independently constructed providers", async () => {
    (env as { GIGACHAT_API_KEY?: string }).GIGACHAT_API_KEY = "test-authorization-key";
    (env as { GIGACHAT_MODEL?: string }).GIGACHAT_MODEL = "GigaChat";

    const fetchImplA = vi.fn().mockResolvedValueOnce(oauthResponse("token-a")).mockResolvedValueOnce(chatResponse());
    const fetchImplB = vi.fn().mockResolvedValueOnce(oauthResponse("token-b")).mockResolvedValueOnce(chatResponse());

    const providerA = createGigaChatProvider(fetchImplA);
    const providerB = createGigaChatProvider(fetchImplB);

    await providerA.generateStructured(request);
    await providerB.generateStructured(request);

    // Each provider instance authenticates independently — no module-level
    // shared cache leaking a token (or a missing one) across instances.
    expect(fetchImplA).toHaveBeenCalledTimes(2);
    expect(fetchImplB).toHaveBeenCalledTimes(2);
  });

  it("on an oauth HTTP error, throws an error containing only the status code — never the authorization key", async () => {
    (env as { GIGACHAT_API_KEY?: string }).GIGACHAT_API_KEY = "super-secret-authorization-key";
    (env as { GIGACHAT_MODEL?: string }).GIGACHAT_MODEL = "GigaChat";

    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ message: "bad key" }, { ok: false, status: 401 }));
    const provider = createGigaChatProvider(fetchImpl);

    let caught: unknown;
    try {
      await provider.generateStructured(request);
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("HTTP 401");
    expect(message).toContain("authentication failed");
    expect(message).not.toContain("super-secret-authorization-key");
  });

  it("classifies an oauth HTTP 429 as 'rate limited'", async () => {
    (env as { GIGACHAT_API_KEY?: string }).GIGACHAT_API_KEY = "test-authorization-key";
    (env as { GIGACHAT_MODEL?: string }).GIGACHAT_MODEL = "GigaChat";

    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 429 }));
    const provider = createGigaChatProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/HTTP 429.*rate limited/);
  });

  it("classifies an oauth HTTP 500 as 'provider error'", async () => {
    (env as { GIGACHAT_API_KEY?: string }).GIGACHAT_API_KEY = "test-authorization-key";
    (env as { GIGACHAT_MODEL?: string }).GIGACHAT_MODEL = "GigaChat";

    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500 }));
    const provider = createGigaChatProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/HTTP 500.*provider error/);
  });

  it("classifies an oauth HTTP 400 as 'request rejected'", async () => {
    (env as { GIGACHAT_API_KEY?: string }).GIGACHAT_API_KEY = "test-authorization-key";
    (env as { GIGACHAT_MODEL?: string }).GIGACHAT_MODEL = "GigaChat";

    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 400 }));
    const provider = createGigaChatProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/HTTP 400.*request rejected/);
  });

  it("propagates a real network failure during the oauth exchange without ever including the authorization key", async () => {
    (env as { GIGACHAT_API_KEY?: string }).GIGACHAT_API_KEY = "super-secret-authorization-key";
    (env as { GIGACHAT_MODEL?: string }).GIGACHAT_MODEL = "GigaChat";

    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed: getaddrinfo ENOTFOUND ngw.devices.sberbank.ru"));
    const provider = createGigaChatProvider(fetchImpl);

    let caught: unknown;
    try {
      await provider.generateStructured(request);
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("network error");
    expect(message).not.toContain("super-secret-authorization-key");
  });

  it("throws when the oauth response is missing an access_token", async () => {
    (env as { GIGACHAT_API_KEY?: string }).GIGACHAT_API_KEY = "test-authorization-key";
    (env as { GIGACHAT_MODEL?: string }).GIGACHAT_MODEL = "GigaChat";

    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({}));
    const provider = createGigaChatProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/did not include an access_token/);
  });

  it("throws when the oauth response body is not valid JSON", async () => {
    (env as { GIGACHAT_API_KEY?: string }).GIGACHAT_API_KEY = "test-authorization-key";
    (env as { GIGACHAT_MODEL?: string }).GIGACHAT_MODEL = "GigaChat";

    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);
    const provider = createGigaChatProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/oauth response was not valid JSON/);
  });

  it("on a chat-completions HTTP error, throws an error containing only the status code — never the access token", async () => {
    (env as { GIGACHAT_API_KEY?: string }).GIGACHAT_API_KEY = "test-authorization-key";
    (env as { GIGACHAT_MODEL?: string }).GIGACHAT_MODEL = "GigaChat";

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(oauthResponse("super-secret-access-token"))
      .mockResolvedValueOnce(jsonResponse({ error: "leaking body should never appear" }, { ok: false, status: 401 }));
    const provider = createGigaChatProvider(fetchImpl);

    let caught: unknown;
    try {
      await provider.generateStructured(request);
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("HTTP 401");
    expect(message).not.toContain("super-secret-access-token");
    expect(message).not.toContain("leaking body");
  });

  it("throws when the chat-completions response is missing message content", async () => {
    (env as { GIGACHAT_API_KEY?: string }).GIGACHAT_API_KEY = "test-authorization-key";
    (env as { GIGACHAT_MODEL?: string }).GIGACHAT_MODEL = "GigaChat";

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(oauthResponse())
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: {} }] }));
    const provider = createGigaChatProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/did not include message content/);
  });

  it("throws when the chat-completions response content is not valid JSON", async () => {
    (env as { GIGACHAT_API_KEY?: string }).GIGACHAT_API_KEY = "test-authorization-key";
    (env as { GIGACHAT_MODEL?: string }).GIGACHAT_MODEL = "GigaChat";

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(oauthResponse())
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "not json" } }] }));
    const provider = createGigaChatProvider(fetchImpl);

    await expect(provider.generateStructured(request)).rejects.toThrow(/response content was not valid JSON/);
  });

  it("propagates a real network failure during the chat-completions call without ever including the access token", async () => {
    (env as { GIGACHAT_API_KEY?: string }).GIGACHAT_API_KEY = "test-authorization-key";
    (env as { GIGACHAT_MODEL?: string }).GIGACHAT_MODEL = "GigaChat";

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(oauthResponse("super-secret-access-token"))
      .mockRejectedValueOnce(new TypeError("fetch failed: getaddrinfo ENOTFOUND api.giga.chat"));
    const provider = createGigaChatProvider(fetchImpl);

    let caught: unknown;
    try {
      await provider.generateStructured(request);
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain("super-secret-access-token");
  });

  it("handles concurrent calls independently once a token is cached — each gets its own response", async () => {
    (env as { GIGACHAT_API_KEY?: string }).GIGACHAT_API_KEY = "test-authorization-key";
    (env as { GIGACHAT_MODEL?: string }).GIGACHAT_MODEL = "GigaChat";

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(oauthResponse("token-1"))
      .mockResolvedValueOnce(chatResponse("warm-up"));
    const provider = createGigaChatProvider(fetchImpl);
    await provider.generateStructured(request); // warms the token cache

    fetchImpl.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages: { content: string }[] };
      const parsedInput = JSON.parse(body.messages[1]!.content) as { question: string };
      return chatResponse(parsedInput.question);
    });

    const [a, b, c] = await Promise.all([
      provider.generateStructured({ ...request, input: { question: "first" } }),
      provider.generateStructured({ ...request, input: { question: "second" } }),
      provider.generateStructured({ ...request, input: { question: "third" } }),
    ]);

    expect(a.data).toEqual({ answer: "first" });
    expect(b.data).toEqual({ answer: "second" });
    expect(c.data).toEqual({ answer: "third" });
  });

  it("forwards request.maxOutputTokens as the wire-level max_tokens field", async () => {
    (env as { GIGACHAT_API_KEY?: string }).GIGACHAT_API_KEY = "test-authorization-key";
    (env as { GIGACHAT_MODEL?: string }).GIGACHAT_MODEL = "GigaChat";

    const fetchImpl = vi.fn().mockResolvedValueOnce(oauthResponse()).mockResolvedValueOnce(chatResponse());
    const provider = createGigaChatProvider(fetchImpl);

    await provider.generateStructured({ ...request, maxOutputTokens: 500 });

    const [, chatInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(chatInit.body as string);
    expect(body.max_tokens).toBe(500);
  });
});
