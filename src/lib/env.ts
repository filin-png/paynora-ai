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
  AI_PROVIDER: z.enum(["none", "gigachat"]).default("none"),
  EMAIL_PROVIDER: z.enum(["none", "smtp"]).default("none"),
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
