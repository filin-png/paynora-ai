import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmailProviderRejectedError, EmailProviderUnknownError, EmailTimeoutError } from "./errors";
import { dispatchEmail } from "./gateway";
import { createFakeEmailProvider } from "./providers/fake";

const message = {
  to: "customer@example.com",
  from: "billing@paynora.example",
  subject: "Payment reminder",
  text: "Please pay your invoice.",
  idempotencyKey: "test-key-1",
};

describe("dispatchEmail", () => {
  it("resolves with the provider's result on success", async () => {
    const provider = createFakeEmailProvider({ kind: "success", providerMessageId: "msg-123" });
    const result = await dispatchEmail(provider, message);
    expect(result).toEqual({ provider: "fake", providerMessageId: "msg-123" });
  });

  it("propagates a definite provider rejection as EmailProviderRejectedError", async () => {
    const provider = createFakeEmailProvider({ kind: "rejected", message: "mailbox does not exist" });
    await expect(dispatchEmail(provider, message)).rejects.toThrow(EmailProviderRejectedError);
  });

  it("normalizes an unrecognized provider error into EmailProviderUnknownError, not a rejection", async () => {
    const provider = createFakeEmailProvider({ kind: "error", message: "ECONNRESET" });
    await expect(dispatchEmail(provider, message)).rejects.toThrow(EmailProviderUnknownError);
  });

  it("times out a provider that never resolves, as EmailTimeoutError (not a rejection)", async () => {
    const provider = createFakeEmailProvider({ kind: "hang" });
    await expect(dispatchEmail(provider, message, { timeoutMs: 20 })).rejects.toThrow(EmailTimeoutError);
  });
});

describe("dispatchEmail — telemetry", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("records a success telemetry event, and only that, on success", async () => {
    const provider = createFakeEmailProvider({ kind: "success", providerMessageId: "msg-123" });
    await dispatchEmail(provider, message);

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy.mock.calls[0]![0]).toContain("result=success");
  });

  it("records a failure telemetry event on a definite rejection — never the message body or recipient", async () => {
    const provider = createFakeEmailProvider({ kind: "rejected", message: "mailbox does not exist" });

    await expect(dispatchEmail(provider, message)).rejects.toThrow(EmailProviderRejectedError);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = errorSpy.mock.calls[0]![0] as string;
    expect(line).toContain("result=failure");
    expect(line).toContain("errorCode=EmailProviderRejectedError");
    expect(line).not.toContain(message.text);
    expect(line).not.toContain(message.to);
  });

  it("records a failure telemetry event on an unknown-outcome error", async () => {
    const provider = createFakeEmailProvider({ kind: "error", message: "ECONNRESET" });

    await expect(dispatchEmail(provider, message)).rejects.toThrow(EmailProviderUnknownError);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toContain("errorCode=EmailProviderUnknownError");
  });

  it("records a timeout telemetry event, distinct from a generic failure", async () => {
    const provider = createFakeEmailProvider({ kind: "hang" });

    await expect(dispatchEmail(provider, message, { timeoutMs: 20 })).rejects.toThrow(EmailTimeoutError);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toContain("result=timeout");
  });
});
