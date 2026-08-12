import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordProviderTelemetry } from "./telemetry";

describe("recordProviderTelemetry", () => {
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

  it("logs a success event via console.info, including every safe field", () => {
    recordProviderTelemetry({
      category: "ai",
      provider: "openrouter",
      operation: "generateStructured",
      result: "success",
      durationMs: 42,
      requestId: "req-123",
      organizationId: "org-456",
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    const line = infoSpy.mock.calls[0]![0] as string;
    expect(line).toContain("category=ai");
    expect(line).toContain("provider=openrouter");
    expect(line).toContain("operation=generateStructured");
    expect(line).toContain("result=success");
    expect(line).toContain("durationMs=42");
    expect(line).toContain("requestId=req-123");
    expect(line).toContain("organizationId=org-456");
  });

  it("logs a failure/timeout event via console.error", () => {
    recordProviderTelemetry({
      category: "email",
      provider: "smtp",
      operation: "send",
      result: "failure",
      durationMs: 10,
      errorCode: "EmailProviderRejectedError",
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]![0]).toContain("errorCode=EmailProviderRejectedError");

    recordProviderTelemetry({
      category: "messaging",
      provider: "telegram",
      operation: "send",
      result: "timeout",
      durationMs: 15000,
    });
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("never includes a field that could carry a secret, body, or payload — only the fixed, documented shape", () => {
    // Structural proof, not just a spot-check: TypeScript itself rejects
    // any field beyond ProviderTelemetryEvent's fixed shape, so a call
    // site can never accidentally pass along an API key, password, email
    // body, or raw webhook payload — there is no field for one to land in.
    recordProviderTelemetry({
      category: "billing",
      provider: "stripe",
      operation: "webhook",
      result: "success",
      durationMs: 5,
      // @ts-expect-error — apiKey is not part of ProviderTelemetryEvent
      apiKey: "sk_live_should_never_compile",
    });
    const line = infoSpy.mock.calls[0]![0] as string;
    expect(line).not.toContain("sk_live");
  });
});
