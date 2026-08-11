import { describe, expect, it } from "vitest";
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
});
