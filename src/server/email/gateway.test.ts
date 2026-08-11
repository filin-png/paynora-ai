import { describe, expect, it } from "vitest";

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
