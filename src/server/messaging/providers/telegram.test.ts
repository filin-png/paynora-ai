import { beforeEach, describe, expect, it, vi } from "vitest";

// See src/server/ai/providers/openrouter.test.ts for why this module is
// mocked rather than mutating `process.env` directly — `@/lib/env`'s `env`
// is a singleton parsed once at startup.
vi.mock("@/lib/env", () => ({
  env: { TELEGRAM_BOT_TOKEN: undefined },
}));

import { env } from "@/lib/env";
import { MessagingConfigurationError, MessagingProviderRejectedError } from "../errors";
import { createTelegramProvider } from "./telegram";

const message = { to: "123456789", text: "Invoice #42 is now overdue.", idempotencyKey: "test-key-1" };

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  (env as { TELEGRAM_BOT_TOKEN?: string }).TELEGRAM_BOT_TOKEN = undefined;
});

describe("Telegram adapter (mocked fetch — no real network, no real bot token)", () => {
  it("refuses to call the network when unconfigured", async () => {
    const fetchImpl = vi.fn();
    const provider = createTelegramProvider(fetchImpl);

    await expect(provider.send(message)).rejects.toThrow(MessagingConfigurationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the correct URL, method, and request body; parses a successful response", async () => {
    (env as { TELEGRAM_BOT_TOKEN?: string }).TELEGRAM_BOT_TOKEN = "test-bot-token";

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 42 } }));
    const provider = createTelegramProvider(fetchImpl);
    const result = await provider.send(message);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bottest-bot-token/sendMessage");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ chat_id: "123456789", text: "Invoice #42 is now overdue." });

    expect(result).toEqual({ provider: "telegram", providerMessageId: "42" });
  });

  it("treats error_code 400 (chat not found) as a definite MessagingProviderRejectedError", async () => {
    (env as { TELEGRAM_BOT_TOKEN?: string }).TELEGRAM_BOT_TOKEN = "test-bot-token";

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, 400));
    const provider = createTelegramProvider(fetchImpl);

    await expect(provider.send(message)).rejects.toThrow(MessagingProviderRejectedError);
    await expect(provider.send(message)).rejects.toThrow(/chat not found/);
  });

  it("treats error_code 403 (bot blocked by the user) as a definite MessagingProviderRejectedError", async () => {
    (env as { TELEGRAM_BOT_TOKEN?: string }).TELEGRAM_BOT_TOKEN = "test-bot-token";

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, 403));
    const provider = createTelegramProvider(fetchImpl);

    await expect(provider.send(message)).rejects.toThrow(MessagingProviderRejectedError);
  });

  it("treats error_code 429 (rate limited) as an unknown outcome, not a rejection", async () => {
    (env as { TELEGRAM_BOT_TOKEN?: string }).TELEGRAM_BOT_TOKEN = "test-bot-token";

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error_code: 429, description: "Too Many Requests" }, 429));
    const provider = createTelegramProvider(fetchImpl);

    let caught: unknown;
    try {
      await provider.send(message);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeInstanceOf(MessagingProviderRejectedError);
    expect(caught).toBeInstanceOf(Error);
  });

  it("never includes the bot token in a thrown error message", async () => {
    (env as { TELEGRAM_BOT_TOKEN?: string }).TELEGRAM_BOT_TOKEN = "super-secret-token";

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error_code: 401, description: "Unauthorized" }, 401));
    const provider = createTelegramProvider(fetchImpl);

    let caught: unknown;
    try {
      await provider.send(message);
    } catch (error) {
      caught = error;
    }
    const errorMessage = caught instanceof Error ? caught.message : String(caught);
    expect(errorMessage).not.toContain("super-secret-token");
  });
});
