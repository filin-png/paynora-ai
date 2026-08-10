import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

const validBase = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/paynora",
  AUTH_SECRET: "a".repeat(32),
};

describe("parseEnv", () => {
  it("applies safe defaults when only required variables are set", () => {
    const env = parseEnv(validBase);
    expect(env.NODE_ENV).toBe("development");
    expect(env.AI_PROVIDER).toBe("none");
  });

  it("accepts a fully valid configuration", () => {
    const env = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/paynora",
      AUTH_SECRET: "b".repeat(40),
      AI_PROVIDER: "gigachat",
    });
    expect(env.NODE_ENV).toBe("production");
    expect(env.AI_PROVIDER).toBe("gigachat");
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() =>
      parseEnv({ AUTH_SECRET: validBase.AUTH_SECRET }),
    ).toThrow(/Invalid environment configuration/);
  });

  it("rejects an invalid DATABASE_URL", () => {
    expect(() =>
      parseEnv({ ...validBase, DATABASE_URL: "not-a-url" }),
    ).toThrow(/Invalid environment configuration/);
  });

  it("rejects a missing AUTH_SECRET", () => {
    expect(() =>
      parseEnv({ DATABASE_URL: validBase.DATABASE_URL }),
    ).toThrow(/Invalid environment configuration/);
  });

  it("rejects an AUTH_SECRET shorter than 32 characters", () => {
    expect(() =>
      parseEnv({ ...validBase, AUTH_SECRET: "too-short" }),
    ).toThrow(/AUTH_SECRET must be at least 32 characters/);
  });

  it("rejects an unknown AI_PROVIDER", () => {
    expect(() => parseEnv({ ...validBase, AI_PROVIDER: "openai" })).toThrow(
      /Invalid environment configuration/,
    );
  });
});
