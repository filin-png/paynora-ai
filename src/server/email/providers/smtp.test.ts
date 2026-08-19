import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EmailMessage } from "../types";

// `vi.resetModules()` below (needed to get a fresh `cachedTransporter`
// per test) also gives every re-imported module — including `../errors`
// — a new instance, so a statically-imported error class here would fail
// `instanceof` against what a freshly-imported `./smtp` actually throws.
// Asserting on `.name` instead sidesteps that identity mismatch entirely.

// Same isolated-mock pattern as src/server/ai/providers/openrouter.test.ts —
// `env` is a real singleton parsed once at process startup, so this file
// mocks the module and mutates the mocked fields per test rather than
// touching real SMTP_* config.
vi.mock("@/lib/env", () => ({
  env: { SMTP_HOST: undefined, SMTP_PORT: undefined, SMTP_USER: undefined, SMTP_PASSWORD: undefined, SMTP_SECURE: false },
}));

const sendMail = vi.fn();
const createTransport = vi.fn((_config: Record<string, unknown>) => ({ sendMail }));
vi.mock("nodemailer", () => ({ default: { createTransport } }));

const message: EmailMessage = {
  to: "customer@example.com",
  from: "billing@paynora-test.example",
  subject: "Invoice INV-1 is overdue",
  text: "Please pay your invoice.",
  idempotencyKey: "comm-1:1",
};

// smtp.ts caches its Transporter at module scope (`cachedTransporter`) so a
// real deployment only ever constructs one — that same caching would leak
// mocked transporter state across these tests if the module weren't
// re-imported fresh each time. `vi.resetModules()` + a fresh dynamic import
// per test gives each one its own `cachedTransporter = null` starting point.
async function freshProvider() {
  vi.resetModules();
  const { smtpEmailProvider } = await import("./smtp");
  return smtpEmailProvider;
}

async function setEnv(overrides: Partial<{ SMTP_HOST: string; SMTP_PORT: number; SMTP_USER: string; SMTP_PASSWORD: string; SMTP_SECURE: boolean }>) {
  const { env } = await import("@/lib/env");
  Object.assign(env as Record<string, unknown>, {
    SMTP_HOST: undefined,
    SMTP_PORT: undefined,
    SMTP_USER: undefined,
    SMTP_PASSWORD: undefined,
    SMTP_SECURE: false,
    ...overrides,
  });
}

beforeEach(async () => {
  sendMail.mockReset();
  createTransport.mockClear();
  await setEnv({});
});

describe("SMTP adapter (mocked nodemailer — no real network, no real credentials)", () => {
  it("refuses to construct a transporter, and never calls nodemailer, when unconfigured", async () => {
    const provider = await freshProvider();

    await expect(provider.send(message)).rejects.toMatchObject({ name: "EmailConfigurationError" });
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("constructs the transporter from SMTP_* config, and sends the exact to/from/subject/text plus the idempotency header", async () => {
    await setEnv({ SMTP_HOST: "smtp.example.com", SMTP_PORT: 587, SMTP_USER: "user", SMTP_PASSWORD: "pass", SMTP_SECURE: false });
    sendMail.mockResolvedValue({ messageId: "<abc123@smtp.example.com>" });
    const provider = await freshProvider();

    const result = await provider.send(message);

    expect(createTransport).toHaveBeenCalledTimes(1);
    const config = createTransport.mock.calls[0]![0] as Record<string, unknown>;
    expect(config.host).toBe("smtp.example.com");
    expect(config.port).toBe(587);
    expect(config.secure).toBe(false);
    expect(config.auth).toEqual({ user: "user", pass: "pass" });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const sent = sendMail.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.to).toBe(message.to);
    expect(sent.from).toBe(message.from);
    expect(sent.subject).toBe(message.subject);
    expect(sent.text).toBe(message.text);
    expect((sent.headers as Record<string, string>)["X-Paynora-Idempotency-Key"]).toBe(message.idempotencyKey);

    expect(result).toEqual({ provider: "smtp", providerMessageId: "<abc123@smtp.example.com>" });
  });

  it("reuses the same transporter across multiple sends within one process (no reconnect per send)", async () => {
    await setEnv({ SMTP_HOST: "smtp.example.com", SMTP_PORT: 587, SMTP_USER: "user", SMTP_PASSWORD: "pass" });
    sendMail.mockResolvedValue({ messageId: "<id>" });
    const provider = await freshProvider();

    await provider.send(message);
    await provider.send(message);

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it("classifies a 5xx SMTP response as a definite EmailProviderRejectedError", async () => {
    await setEnv({ SMTP_HOST: "smtp.example.com", SMTP_PORT: 587, SMTP_USER: "user", SMTP_PASSWORD: "pass" });
    const rejection = Object.assign(new Error("mailbox unavailable"), { responseCode: 550 });
    sendMail.mockRejectedValue(rejection);
    const provider = await freshProvider();

    await expect(provider.send(message)).rejects.toMatchObject({ name: "EmailProviderRejectedError" });
  });

  it("classifies a client-side envelope error (EENVELOPE) as a definite rejection", async () => {
    await setEnv({ SMTP_HOST: "smtp.example.com", SMTP_PORT: 587, SMTP_USER: "user", SMTP_PASSWORD: "pass" });
    sendMail.mockRejectedValue(Object.assign(new Error("No recipients defined"), { code: "EENVELOPE" }));
    const provider = await freshProvider();

    await expect(provider.send(message)).rejects.toMatchObject({ name: "EmailProviderRejectedError" });
  });

  it("does NOT classify a 4xx (transient) response as a definite rejection — outcome stays unknown", async () => {
    await setEnv({ SMTP_HOST: "smtp.example.com", SMTP_PORT: 587, SMTP_USER: "user", SMTP_PASSWORD: "pass" });
    const transient = Object.assign(new Error("greylisted, try again later"), { responseCode: 450 });
    sendMail.mockRejectedValue(transient);
    const provider = await freshProvider();

    let caught: unknown;
    try {
      await provider.send(message);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).name).not.toBe("EmailProviderRejectedError");
    expect(caught).toBe(transient);
  });

  it("does NOT classify a connection-level error as a definite rejection — outcome stays unknown", async () => {
    await setEnv({ SMTP_HOST: "smtp.example.com", SMTP_PORT: 587, SMTP_USER: "user", SMTP_PASSWORD: "pass" });
    sendMail.mockRejectedValue(Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" }));
    const provider = await freshProvider();

    await expect(provider.send(message)).rejects.not.toMatchObject({ name: "EmailProviderRejectedError" });
  });
});
