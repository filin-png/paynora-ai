import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

describe("parseEnv", () => {
  it("applies safe defaults when no variables are set", () => {
    const env = parseEnv({});
    expect(env.NODE_ENV).toBe("development");
    expect(env.AI_PROVIDER).toBe("none");
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("accepts a valid configuration", () => {
    const env = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/paynora",
      AI_PROVIDER: "gigachat",
    });
    expect(env.NODE_ENV).toBe("production");
    expect(env.AI_PROVIDER).toBe("gigachat");
    expect(env.DATABASE_URL).toBe(
      "postgresql://user:pass@localhost:5432/paynora",
    );
  });

  it("rejects an invalid DATABASE_URL", () => {
    expect(() => parseEnv({ DATABASE_URL: "not-a-url" })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it("rejects an unknown AI_PROVIDER", () => {
    expect(() => parseEnv({ AI_PROVIDER: "openai" })).toThrow(
      /Invalid environment configuration/,
    );
  });
});
