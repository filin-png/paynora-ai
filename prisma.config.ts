import { config as loadEnv } from "dotenv";
import { defineConfig, env } from "prisma/config";

// Prisma 7's config-first setup does not auto-load .env files the way
// older Prisma versions did — this loads the same .env.local Next.js
// reads, falling back to .env, so `prisma migrate`/`generate`/`validate`
// see the same DATABASE_URL as `next dev`. Real environment variables
// (e.g. set by CI) are never overridden — dotenv only fills in what's
// missing.
loadEnv({ path: ".env.local" });
loadEnv();

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
});
