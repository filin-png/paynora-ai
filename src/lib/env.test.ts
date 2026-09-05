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

  it("defaults EMAIL_PROVIDER to none with no other email config required", () => {
    const env = parseEnv(validBase);
    expect(env.EMAIL_PROVIDER).toBe("none");
    expect(env.PAYNORA_EMAIL_FROM).toBeUndefined();
  });

  it("rejects EMAIL_PROVIDER=smtp with no PAYNORA_EMAIL_FROM or SMTP config", () => {
    expect(() => parseEnv({ ...validBase, EMAIL_PROVIDER: "smtp" })).toThrow(
      /PAYNORA_EMAIL_FROM is required/,
    );
  });

  it("rejects EMAIL_PROVIDER=smtp missing individual SMTP fields", () => {
    expect(() =>
      parseEnv({
        ...validBase,
        EMAIL_PROVIDER: "smtp",
        PAYNORA_EMAIL_FROM: "billing@example.com",
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: "587",
        // SMTP_USER / SMTP_PASSWORD missing
      }),
    ).toThrow(/SMTP_USER is required/);
  });

  it("rejects an invalid PAYNORA_EMAIL_FROM", () => {
    expect(() =>
      parseEnv({ ...validBase, EMAIL_PROVIDER: "smtp", PAYNORA_EMAIL_FROM: "not-an-email" }),
    ).toThrow(/PAYNORA_EMAIL_FROM must be a valid email address/);
  });

  it("accepts a fully valid smtp configuration", () => {
    const env = parseEnv({
      ...validBase,
      EMAIL_PROVIDER: "smtp",
      PAYNORA_EMAIL_FROM: "billing@example.com",
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_USER: "billing",
      SMTP_PASSWORD: "secret",
      SMTP_SECURE: "true",
    });
    expect(env.EMAIL_PROVIDER).toBe("smtp");
    expect(env.SMTP_PORT).toBe(587);
    expect(env.SMTP_SECURE).toBe(true);
  });

  it("SMTP_SECURE defaults to false when unset", () => {
    const env = parseEnv(validBase);
    expect(env.SMTP_SECURE).toBe(false);
  });

  it("defaults AUTOMATION_ENABLED to false with no cron secret required", () => {
    const env = parseEnv(validBase);
    expect(env.AUTOMATION_ENABLED).toBe(false);
    expect(env.AUTOMATION_CRON_SECRET).toBeUndefined();
  });

  it("rejects AUTOMATION_ENABLED=true with no AUTOMATION_CRON_SECRET", () => {
    expect(() => parseEnv({ ...validBase, AUTOMATION_ENABLED: "true" })).toThrow(
      /AUTOMATION_CRON_SECRET is required/,
    );
  });

  it("rejects an AUTOMATION_CRON_SECRET shorter than 20 characters", () => {
    expect(() =>
      parseEnv({ ...validBase, AUTOMATION_ENABLED: "true", AUTOMATION_CRON_SECRET: "too-short" }),
    ).toThrow(/AUTOMATION_CRON_SECRET must be at least 20 characters/);
  });

  it("accepts AUTOMATION_ENABLED=true with a valid AUTOMATION_CRON_SECRET", () => {
    const env = parseEnv({
      ...validBase,
      AUTOMATION_ENABLED: "true",
      AUTOMATION_CRON_SECRET: "c".repeat(24),
    });
    expect(env.AUTOMATION_ENABLED).toBe(true);
    expect(env.AUTOMATION_CRON_SECRET).toBe("c".repeat(24));
  });

  it("defaults MESSAGING_PROVIDER/BILLING_PROVIDER/DEPLOYMENT_PROFILE safely with no other config required", () => {
    const env = parseEnv(validBase);
    expect(env.MESSAGING_PROVIDER).toBe("none");
    expect(env.BILLING_PROVIDER).toBe("none");
    expect(env.DEPLOYMENT_PROFILE).toBe("LOCAL_TEST");
    expect(env.AI_PROVIDER_FALLBACK).toBeUndefined();
  });

  it("rejects AI_PROVIDER_FALLBACK equal to AI_PROVIDER", () => {
    expect(() =>
      parseEnv({ ...validBase, AI_PROVIDER: "openrouter", AI_PROVIDER_FALLBACK: "openrouter" }),
    ).toThrow(/AI_PROVIDER_FALLBACK must differ from AI_PROVIDER/);
  });

  it("rejects AI_PROVIDER=openrouter with no OPENROUTER_API_KEY/OPENROUTER_MODEL", () => {
    expect(() => parseEnv({ ...validBase, AI_PROVIDER: "openrouter" })).toThrow(
      /OPENROUTER_API_KEY and OPENROUTER_MODEL are required/,
    );
  });

  it("accepts AI_PROVIDER=openrouter with a valid key and model", () => {
    const env = parseEnv({
      ...validBase,
      AI_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "sk-or-test",
      OPENROUTER_MODEL: "test-model",
    });
    expect(env.AI_PROVIDER).toBe("openrouter");
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-test");
  });

  it("rejects AI_PROVIDER=mistral with no MISTRAL_API_KEY/MISTRAL_MODEL", () => {
    expect(() => parseEnv({ ...validBase, AI_PROVIDER: "mistral" })).toThrow(
      /MISTRAL_API_KEY and MISTRAL_MODEL are required/,
    );
  });

  it("accepts AI_PROVIDER=mistral with a valid key and model", () => {
    const env = parseEnv({
      ...validBase,
      AI_PROVIDER: "mistral",
      MISTRAL_API_KEY: "test-key",
      MISTRAL_MODEL: "test-model",
    });
    expect(env.AI_PROVIDER).toBe("mistral");
  });

  it("requires OPENROUTER_API_KEY/OPENROUTER_MODEL when openrouter is only the fallback, not the primary", () => {
    expect(() =>
      parseEnv({
        ...validBase,
        AI_PROVIDER: "mistral",
        MISTRAL_API_KEY: "test-key",
        MISTRAL_MODEL: "test-model",
        AI_PROVIDER_FALLBACK: "openrouter",
      }),
    ).toThrow(/OPENROUTER_API_KEY and OPENROUTER_MODEL are required/);
  });

  it("accepts a primary + fallback AI configuration when both are fully configured", () => {
    const env = parseEnv({
      ...validBase,
      AI_PROVIDER: "mistral",
      MISTRAL_API_KEY: "test-key",
      MISTRAL_MODEL: "test-model",
      AI_PROVIDER_FALLBACK: "openrouter",
      OPENROUTER_API_KEY: "sk-or-test",
      OPENROUTER_MODEL: "test-model",
    });
    expect(env.AI_PROVIDER).toBe("mistral");
    expect(env.AI_PROVIDER_FALLBACK).toBe("openrouter");
  });

  it("rejects MESSAGING_PROVIDER=telegram with no TELEGRAM_BOT_TOKEN", () => {
    expect(() => parseEnv({ ...validBase, MESSAGING_PROVIDER: "telegram" })).toThrow(
      /TELEGRAM_BOT_TOKEN is required/,
    );
  });

  it("accepts MESSAGING_PROVIDER=telegram with a TELEGRAM_BOT_TOKEN", () => {
    const env = parseEnv({
      ...validBase,
      MESSAGING_PROVIDER: "telegram",
      TELEGRAM_BOT_TOKEN: "123456:ABC-test-token",
    });
    expect(env.MESSAGING_PROVIDER).toBe("telegram");
    expect(env.TELEGRAM_BOT_TOKEN).toBe("123456:ABC-test-token");
  });

  it("accepts BILLING_PROVIDER=stripe (still unimplemented, no credential schema yet) and any recognized DEPLOYMENT_PROFILE with no further config required", () => {
    expect(parseEnv({ ...validBase, BILLING_PROVIDER: "stripe" }).BILLING_PROVIDER).toBe("stripe");
    expect(parseEnv({ ...validBase, DEPLOYMENT_PROFILE: "RU" }).DEPLOYMENT_PROFILE).toBe("RU");
    expect(parseEnv({ ...validBase, DEPLOYMENT_PROFILE: "GLOBAL" }).DEPLOYMENT_PROFILE).toBe("GLOBAL");
  });

  it("rejects BILLING_PROVIDER=yookassa with no YUKASSA_SHOP_ID/YUKASSA_SECRET_KEY (Phase 20: yookassa has a real adapter, so it needs real credentials)", () => {
    expect(() => parseEnv({ ...validBase, BILLING_PROVIDER: "yookassa" })).toThrow(
      /YUKASSA_SHOP_ID is required when BILLING_PROVIDER="yookassa"/,
    );
    expect(() => parseEnv({ ...validBase, BILLING_PROVIDER: "yookassa" })).toThrow(
      /YUKASSA_SECRET_KEY is required when BILLING_PROVIDER="yookassa"/,
    );
  });

  it("accepts BILLING_PROVIDER=yookassa with YUKASSA_SHOP_ID/YUKASSA_SECRET_KEY set", () => {
    const env = parseEnv({
      ...validBase,
      BILLING_PROVIDER: "yookassa",
      YUKASSA_SHOP_ID: "shop-test-id",
      YUKASSA_SECRET_KEY: "test_secret_key",
    });
    expect(env.BILLING_PROVIDER).toBe("yookassa");
    expect(env.YUKASSA_SHOP_ID).toBe("shop-test-id");
    expect(env.YUKASSA_SECRET_KEY).toBe("test_secret_key");
  });

  it("rejects an unknown DEPLOYMENT_PROFILE", () => {
    expect(() => parseEnv({ ...validBase, DEPLOYMENT_PROFILE: "MARS" })).toThrow(
      /Invalid environment configuration/,
    );
  });
});
