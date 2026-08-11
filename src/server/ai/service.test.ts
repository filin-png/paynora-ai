import { describe, expect, it } from "vitest";
import { z } from "zod";

import { isAIEnabled, tryGenerateStructured } from "./service";

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
