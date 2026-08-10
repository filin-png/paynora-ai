import { z } from "zod";

/**
 * Environment schema for the current project phase.
 *
 * Nothing here is required to boot the app locally — DATABASE_URL and
 * AI_PROVIDER credentials are introduced by later phases (see ROADMAP.md).
 * Keeping them optional now means Phase 0 never requires a paid or
 * foreign-only service just to run `next dev`.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().url().optional(),
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
