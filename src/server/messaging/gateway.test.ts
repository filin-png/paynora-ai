import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MessagingProviderRejectedError, MessagingProviderUnknownError, MessagingTimeoutError } from "./errors";
import { dispatchMessage } from "./gateway";
import { createFakeMessagingProvider } from "./providers/fake";

const message = {
  to: "123456789",
  text: "Invoice #42 is now overdue.",
  idempotencyKey: "test-key-1",
};

describe("dispatchMessage", () => {
  it("resolves with the provider's result on success", async () => {
    const provider = createFakeMessagingProvider({ kind: "success", providerMessageId: "msg-123" });
    const result = await dispatchMessage(provider, message);
    expect(result).toEqual({ provider: "fake", providerMessageId: "msg-123" });
  });

  it("propagates a definite provider rejection as MessagingProviderRejectedError", async () => {
    const provider = createFakeMessagingProvider({ kind: "rejected", message: "chat not found" });
    await expect(dispatchMessage(provider, message)).rejects.toThrow(MessagingProviderRejectedError);
  });

  it("normalizes an unrecognized provider error into MessagingProviderUnknownError, not a rejection", async () => {
    const provider = createFakeMessagingProvider({ kind: "error", message: "ECONNRESET" });
    await expect(dispatchMessage(provider, message)).rejects.toThrow(MessagingProviderUnknownError);
  });

  it("times out a provider that never resolves, as MessagingTimeoutError (not a rejection)", async () => {
    const provider = createFakeMessagingProvider({ kind: "hang" });
    await expect(dispatchMessage(provider, message, { timeoutMs: 20 })).rejects.toThrow(MessagingTimeoutError);
  });
});

describe("dispatchMessage — telemetry", () => {
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
    const provider = createFakeMessagingProvider({ kind: "success", providerMessageId: "msg-123" });
    await dispatchMessage(provider, message);

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy.mock.calls[0]![0]).toContain("result=success");
  });

  it("records a failure telemetry event on a definite rejection — never the message text or recipient", async () => {
    const provider = createFakeMessagingProvider({ kind: "rejected", message: "chat not found" });

    await expect(dispatchMessage(provider, message)).rejects.toThrow(MessagingProviderRejectedError);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = errorSpy.mock.calls[0]![0] as string;
    expect(line).toContain("result=failure");
    expect(line).toContain("errorCode=MessagingProviderRejectedError");
    expect(line).not.toContain(message.text);
    expect(line).not.toContain(message.to);
  });

  it("records a failure telemetry event on an unknown-outcome error", async () => {
    const provider = createFakeMessagingProvider({ kind: "error", message: "ECONNRESET" });

    await expect(dispatchMessage(provider, message)).rejects.toThrow(MessagingProviderUnknownError);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toContain("errorCode=MessagingProviderUnknownError");
  });

  it("records a timeout telemetry event, distinct from a generic failure", async () => {
    const provider = createFakeMessagingProvider({ kind: "hang" });

    await expect(dispatchMessage(provider, message, { timeoutMs: 20 })).rejects.toThrow(MessagingTimeoutError);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toContain("result=timeout");
  });
});
