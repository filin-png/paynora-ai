import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AIProviderError, AITimeoutError, AIValidationError } from "./errors";
import { runAIGeneration } from "./gateway";
import { createFakeProvider } from "./providers/fake";

const schema = z.object({ tone: z.enum(["friendly", "professional", "firm"]), summary: z.string() });

describe("runAIGeneration", () => {
  it("returns validated data on a well-formed response", async () => {
    const provider = createFakeProvider({
      kind: "success",
      data: { tone: "professional", summary: "Invoice is overdue." },
    });

    const result = await runAIGeneration(provider, {
      system: "instructions",
      input: { fact: "value" },
      schema,
    });

    expect(result.data).toEqual({ tone: "professional", summary: "Invoice is overdue." });
    expect(result.provider).toBe("fake");
  });

  it("rejects output that fails the request's schema", async () => {
    const provider = createFakeProvider({ kind: "invalid", data: { tone: "angry", summary: 42 } });

    await expect(
      runAIGeneration(provider, { system: "instructions", input: {}, schema }),
    ).rejects.toThrow(AIValidationError);
  });

  it("rejects output missing required fields", async () => {
    const provider = createFakeProvider({ kind: "invalid", data: { tone: "professional" } });

    await expect(
      runAIGeneration(provider, { system: "instructions", input: {}, schema }),
    ).rejects.toThrow(AIValidationError);
  });

  it("normalizes a provider throw into AIProviderError", async () => {
    const provider = createFakeProvider({ kind: "error", message: "vendor 500" });

    await expect(
      runAIGeneration(provider, { system: "instructions", input: {}, schema }),
    ).rejects.toThrow(AIProviderError);
  });

  it("times out a provider that never resolves", async () => {
    const provider = createFakeProvider({ kind: "hang" });

    await expect(
      runAIGeneration(provider, { system: "instructions", input: {}, schema }, { timeoutMs: 20 }),
    ).rejects.toThrow(AITimeoutError);
  });

  it("actually cancels the in-flight request on timeout — not just a local promise race", async () => {
    // A real HTTP adapter forwards this signal to fetch(); this proves the
    // gateway hands the provider a signal that genuinely fires on timeout,
    // not just abandons the promise while the underlying request keeps
    // running server-side. See src/server/ai/gateway.ts's doc comment.
    let capturedSignal: AbortSignal | undefined;
    const provider = {
      name: "capturing",
      generateStructured: (_req: unknown, options?: { signal?: AbortSignal }) => {
        capturedSignal = options?.signal;
        return new Promise(() => {
          // never resolves — exercising timeout, same as the "hang" fake.
        });
      },
    };

    await expect(
      runAIGeneration(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal inline test double, not a real AIProvider<T>
        provider as any,
        { system: "instructions", input: {}, schema },
        { timeoutMs: 20 },
      ),
    ).rejects.toThrow(AITimeoutError);

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });
});

describe("runAIGeneration — telemetry", () => {
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

  it("records a success telemetry event, and only that, on a well-formed response", async () => {
    const provider = createFakeProvider({
      kind: "success",
      data: { tone: "professional", summary: "Invoice is overdue." },
    });

    await runAIGeneration(provider, { system: "instructions", input: { fact: "value" }, schema });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy.mock.calls[0]![0]).toContain("result=success");
  });

  it("records a failure telemetry event on a provider error — never the request contents", async () => {
    const provider = createFakeProvider({ kind: "error", message: "vendor 500: secret-token-abc" });

    await expect(
      runAIGeneration(provider, { system: "top secret instructions", input: { ssn: "123-45-6789" }, schema }),
    ).rejects.toThrow(AIProviderError);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = errorSpy.mock.calls[0]![0] as string;
    expect(line).toContain("result=failure");
    expect(line).toContain("errorCode=AIProviderError");
    expect(line).not.toContain("top secret instructions");
    expect(line).not.toContain("123-45-6789");
  });

  it("records a timeout telemetry event, distinct from a generic failure", async () => {
    const provider = createFakeProvider({ kind: "hang" });

    await expect(
      runAIGeneration(provider, { system: "instructions", input: {}, schema }, { timeoutMs: 20 }),
    ).rejects.toThrow(AITimeoutError);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toContain("result=timeout");
  });

  it("records a failure telemetry event when the provider's output fails schema validation", async () => {
    const provider = createFakeProvider({ kind: "invalid", data: { tone: "angry", summary: 42 } });

    await expect(
      runAIGeneration(provider, { system: "instructions", input: {}, schema }),
    ).rejects.toThrow(AIValidationError);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toContain("errorCode=AIValidationError");
  });
});
