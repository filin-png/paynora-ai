import { z } from "zod";

/**
 * Environment schema for the current project phase.
 *
 * From Phase 1 onward, DATABASE_URL and AUTH_SECRET are genuinely required
 * — authentication cannot function without them. Both are free and local
 * (see DEPLOYMENT.md): a local Postgres instance and a locally generated
 * secret, no paid or foreign-only service. Missing or malformed values fail
 * loudly at startup instead of falling back to an insecure default.
 */
/**
 * Email sending (Phase 4, see docs/communications.md) is optional the same
 * way AI is: `EMAIL_PROVIDER` defaults to `"none"`, and the app boots and
 * every non-sending feature (drafting, preview, editing) works without any
 * of the variables below set. They're only cross-validated as required
 * once a real provider is selected — see the `superRefine` below.
 */
const baseEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().url(),
  AUTH_SECRET: z
    .string()
    .min(
      32,
      "AUTH_SECRET must be at least 32 characters — generate one with `openssl rand -base64 33`",
    ),
  // Phase 6 extends this to a routing table (src/server/ai/service.ts) —
  // "gigachat"/"yandex" remain recognized-but-not-implemented (same
  // precedent as gigachat since Phase 3: selecting them throws a clear,
  // typed "not implemented yet" error rather than silently doing nothing
  // or pretending to work); "openrouter"/"mistral" have real adapters.
  AI_PROVIDER: z.enum(["none", "gigachat", "yandex", "openrouter", "mistral"]).default("none"),
  // Optional single fallback, tried only if the primary fails — never a
  // chain, never retried past one confirmed success. See
  // src/server/ai/service.ts and docs/integration-architecture.md#ai-routing.
  AI_PROVIDER_FALLBACK: z.enum(["gigachat", "yandex", "openrouter", "mistral"]).optional(),
  OPENROUTER_API_KEY: z.string().trim().min(1).optional(),
  OPENROUTER_MODEL: z.string().trim().min(1).optional(),
  MISTRAL_API_KEY: z.string().trim().min(1).optional(),
  MISTRAL_MODEL: z.string().trim().min(1).optional(),
  EMAIL_PROVIDER: z.enum(["none", "smtp"]).default("none"),
  // Phase 11.2: base URL used to build password-reset and organization-
  // invitation links embedded in transactional emails (and returned by
  // Server Actions for redirect purposes) — see
  // src/server/auth/password-reset.ts and src/server/tenancy/invitations.ts.
  // Defaults to the local dev server; a real deployment must set this to
  // its actual public origin or every emailed link would point at
  // localhost.
  APP_BASE_URL: z.string().trim().url("APP_BASE_URL must be a valid URL").default("http://localhost:3000"),
  // The sender identity for every outgoing email, regardless of provider —
  // never user-supplied per-message, see docs/communications.md#sender-safety.
  PAYNORA_EMAIL_FROM: z
    .string()
    .trim()
    .email("PAYNORA_EMAIL_FROM must be a valid email address")
    .optional(),
  SMTP_HOST: z.string().trim().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().max(65535).optional(),
  SMTP_USER: z.string().trim().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  // Phase 5 deployment-level kill switch (see docs/collections-automation.md
  // #kill-switch). Defaults OFF: runAutomationTick refuses to do anything
  // external unless this is explicitly "true", regardless of any
  // per-organization automationEnabled setting — a genuine external side
  // effect (sending email) must never happen just because a database row
  // says so, without an explicit deployment-level opt-in too.
  AUTOMATION_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  // Bearer secret the internal scheduler endpoint
  // (POST /internal/automation/tick) requires — never accepted from a
  // normal user session. Only required once AUTOMATION_ENABLED="true".
  AUTOMATION_CRON_SECRET: z
    .string()
    .min(20, "AUTOMATION_CRON_SECRET must be at least 20 characters")
    .optional(),
  // Phase 6: MessagingProvider boundary (src/server/messaging/*) — a
  // foundation with no domain call site yet (see
  // docs/integration-architecture.md#messaging). "none" is the default;
  // nothing sends a Telegram message anywhere in this codebase today.
  MESSAGING_PROVIDER: z.enum(["none", "telegram"]).default("none"),
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1).optional(),
  // Phase 6: BillingProvider boundary (src/server/billing/*) — interface
  // and normalized types only. Selecting "stripe"/"yookassa" resolves to a
  // clear "not implemented yet" error, the same precedent as AI_PROVIDER's
  // unimplemented values — see docs/integration-architecture.md#billing.
  BILLING_PROVIDER: z.enum(["none", "stripe", "yookassa"]).default("none"),
  // Purely descriptive metadata consumed by the provider registry
  // (src/server/providers/registry.ts) to annotate which vendor set a
  // deployment is expected to use — never enforced as a hard restriction;
  // one codebase, different provider configurations. See
  // docs/integration-architecture.md#deployment-profiles.
  DEPLOYMENT_PROFILE: z.enum(["RU", "GLOBAL", "LOCAL_TEST"]).default("LOCAL_TEST"),
  // Phase 9: how many automationEnabled organizations one
  // runAutomationTick invocation processes, bounding a single scheduler
  // call's work — see src/server/collections/engine.ts and
  // docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-5. The remaining
  // organizations are picked up by the next invocation via
  // Organization.automationLastTickAt, not lost.
  AUTOMATION_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  // Phase 9: per-organization, per-hour safety ceilings on expensive,
  // provider-backed operations — a defense against a compromised/
  // malicious member or a runaway client generating unbounded real AI/
  // email/Telegram vendor spend, not a commercial plan limit. See
  // src/server/rate-limit/policies.ts and
  // docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-7.
  RATE_LIMIT_AI_GENERATION_PER_HOUR: z.coerce.number().int().positive().default(50),
  RATE_LIMIT_COMMUNICATION_SEND_PER_HOUR: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_OPERATOR_RUN_PER_HOUR: z.coerce.number().int().positive().default(20),
  // Phase 9: `pg.Pool`'s max connections per process — see
  // src/server/db/client.ts and DEPLOYMENT.md#connection-pooling. The
  // default (10) matches node-postgres's own default; deployments running
  // many concurrent serverless instances against one Postgres server
  // should size this deliberately, not leave it unbounded.
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
});

export const envSchema = baseEnvSchema.superRefine((data, ctx) => {
  if (data.EMAIL_PROVIDER !== "none" && !data.PAYNORA_EMAIL_FROM) {
    ctx.addIssue({
      code: "custom",
      path: ["PAYNORA_EMAIL_FROM"],
      message: `PAYNORA_EMAIL_FROM is required when EMAIL_PROVIDER="${data.EMAIL_PROVIDER}"`,
    });
  }
  if (data.EMAIL_PROVIDER === "smtp") {
    const required = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"] as const;
    for (const key of required) {
      if (data[key] === undefined) {
        ctx.addIssue({ code: "custom", path: [key], message: `${key} is required when EMAIL_PROVIDER="smtp"` });
      }
    }
  }
  if (data.AUTOMATION_ENABLED && !data.AUTOMATION_CRON_SECRET) {
    ctx.addIssue({
      code: "custom",
      path: ["AUTOMATION_CRON_SECRET"],
      message: 'AUTOMATION_CRON_SECRET is required when AUTOMATION_ENABLED="true"',
    });
  }

  const selectedAiProviders = [data.AI_PROVIDER, data.AI_PROVIDER_FALLBACK].filter(
    (value): value is NonNullable<typeof value> => value !== undefined && value !== "none",
  );
  if (data.AI_PROVIDER_FALLBACK && data.AI_PROVIDER_FALLBACK === data.AI_PROVIDER) {
    ctx.addIssue({
      code: "custom",
      path: ["AI_PROVIDER_FALLBACK"],
      message: "AI_PROVIDER_FALLBACK must differ from AI_PROVIDER — falling back to the same provider is meaningless",
    });
  }
  if (selectedAiProviders.includes("openrouter") && (!data.OPENROUTER_API_KEY || !data.OPENROUTER_MODEL)) {
    ctx.addIssue({
      code: "custom",
      path: ["OPENROUTER_API_KEY"],
      message: 'OPENROUTER_API_KEY and OPENROUTER_MODEL are required when AI_PROVIDER or AI_PROVIDER_FALLBACK is "openrouter"',
    });
  }
  if (selectedAiProviders.includes("mistral") && (!data.MISTRAL_API_KEY || !data.MISTRAL_MODEL)) {
    ctx.addIssue({
      code: "custom",
      path: ["MISTRAL_API_KEY"],
      message: 'MISTRAL_API_KEY and MISTRAL_MODEL are required when AI_PROVIDER or AI_PROVIDER_FALLBACK is "mistral"',
    });
  }

  if (data.MESSAGING_PROVIDER === "telegram" && !data.TELEGRAM_BOT_TOKEN) {
    ctx.addIssue({
      code: "custom",
      path: ["TELEGRAM_BOT_TOKEN"],
      message: 'TELEGRAM_BOT_TOKEN is required when MESSAGING_PROVIDER="telegram"',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `- ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

export const env = parseEnv();
