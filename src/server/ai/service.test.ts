import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createFakeProvider } from "./providers/fake";
import { isAIEnabled, resolveProviderByName, tryGenerateStructured, type AiProviderName } from "./service";

describe("AI service (AI_PROVIDER=none, the test/CI default)", () => {
  it("reports AI as disabled", () => {
    expect(isAIEnabled()).toBe(false);
  });

  it("degrades to null instead of throwing when AI is disabled", async () => {
    const result = await tryGenerateStructured({
      system: "instructions",
      input: { anything: "goes" },
      schema: z.object({}),
    });
    expect(result).toBeNull();
  });
});

describe("resolveProviderByName", () => {
  it("resolves none/openrouter/mistral to real, distinct provider instances", () => {
    expect(resolveProviderByName("none").name).toBe("none");
    expect(resolveProviderByName("openrouter").name).toBe("openrouter");
    expect(resolveProviderByName("mistral").name).toBe("mistral");
  });

  it("throws a clear, typed error for recognized-but-unimplemented vendors", () => {
    expect(() => resolveProviderByName("gigachat")).toThrow(/not implemented/);
    expect(() => resolveProviderByName("yandex")).toThrow(/not implemented/);
  });
});

const schema = z.object({ answer: z.string() });
const request = { system: "instructions", input: { anything: "goes" }, schema };

describe("tryGenerateStructured — routing and fallback (via DI, no real network)", () => {
  it("returns the primary's result and never calls the fallback when the primary succeeds", async () => {
    let fallbackCalled = false;
    const primary = createFakeProvider({ kind: "success", data: { answer: "from-primary" } }, "primary");
    const fallback = createFakeProvider({ kind: "success", data: { answer: "from-fallback" } }, "fallback");

    const result = await tryGenerateStructured(request, {
      enabled: true,
      order: ["gigachat", "yandex"] as AiProviderName[],
      resolve: (name) => {
        if (name === "yandex") fallbackCalled = true;
        return name === "gigachat" ? primary : fallback;
      },
    });

    expect(result?.data).toEqual({ answer: "from-primary" });
    expect(fallbackCalled).toBe(false);
  });

  it("falls back exactly once when the primary fails, and returns the fallback's result", async () => {
    const primary = createFakeProvider({ kind: "error", message: "primary down" }, "primary");
    const fallback = createFakeProvider({ kind: "success", data: { answer: "from-fallback" } }, "fallback");
    let resolveCallCount = 0;

    const result = await tryGenerateStructured(request, {
      enabled: true,
      order: ["gigachat", "yandex"] as AiProviderName[],
      resolve: (name) => {
        resolveCallCount += 1;
        return name === "gigachat" ? primary : fallback;
      },
    });

    expect(result?.data).toEqual({ answer: "from-fallback" });
    expect(resolveCallCount).toBe(2);
  });

  it("is bounded: exactly the configured attempts, never more, and returns null if all fail", async () => {
    const alwaysFails = createFakeProvider({ kind: "error", message: "down" }, "always-fails");
    let resolveCallCount = 0;

    const result = await tryGenerateStructured(request, {
      enabled: true,
      order: ["gigachat", "yandex"] as AiProviderName[],
      resolve: () => {
        resolveCallCount += 1;
        return alwaysFails;
      },
    });

    expect(result).toBeNull();
    expect(resolveCallCount).toBe(2); // exactly primary + one fallback — never a longer chain, never retried
  });

  it("with no fallback configured, a failing primary yields null after exactly one attempt", async () => {
    let resolveCallCount = 0;
    const result = await tryGenerateStructured(request, {
      enabled: true,
      order: ["gigachat"] as AiProviderName[],
      resolve: () => {
        resolveCallCount += 1;
        return createFakeProvider({ kind: "error", message: "down" }, "primary");
      },
    });
    expect(result).toBeNull();
    expect(resolveCallCount).toBe(1);
  });

  it("treats a recognized-but-unimplemented vendor as a failed attempt, not a thrown error", async () => {
    // Uses the real resolveProviderByName (no override) — gigachat really
    // does throw "not implemented", and that must be caught and treated
    // as "try the next one" / "return null", never escape as an
    // unhandled rejection.
    await expect(
      tryGenerateStructured(request, { enabled: true, order: ["gigachat"] as AiProviderName[] }),
    ).resolves.toBeNull();
  });

  it("invalid output from the primary is treated as a failure, falling back correctly", async () => {
    const primary = createFakeProvider({ kind: "invalid", data: { wrong: "shape" } }, "primary");
    const fallback = createFakeProvider({ kind: "success", data: { answer: "from-fallback" } }, "fallback");

    const result = await tryGenerateStructured(request, {
      enabled: true,
      order: ["gigachat", "yandex"] as AiProviderName[],
      resolve: (name) => (name === "gigachat" ? primary : fallback),
    });

    expect(result?.data).toEqual({ answer: "from-fallback" });
  });

  it("respects the enabled override — false short-circuits to null without resolving anything", async () => {
    let resolveCalled = false;
    const result = await tryGenerateStructured(request, {
      enabled: false,
      order: ["gigachat"] as AiProviderName[],
      resolve: () => {
        resolveCalled = true;
        return createFakeProvider({ kind: "success", data: { answer: "x" } });
      },
    });
    expect(result).toBeNull();
    expect(resolveCalled).toBe(false);
  });
});
