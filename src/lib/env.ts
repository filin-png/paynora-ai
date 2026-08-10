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
export const envSchema = z.object({
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
