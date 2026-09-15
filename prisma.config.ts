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
    // DIRECT_URL (optional): a non-pooled Postgres connection string.
    // Required only when DATABASE_URL points at a transaction-mode pooler
    // (Neon's pooled endpoint, PgBouncer, etc — the recommended setup for
    // any per-invocation serverless deployment, see
    // docs/production-readiness.md#database). Prisma's migration engine
    // holds an advisory lock and session state across statements, which a
    // transaction-pooled connection cannot provide — so `prisma migrate
    // deploy`/`dev`/`db push` must always go through the *direct*
    // connection, never the pooled one. Falls back to DATABASE_URL so a
    // single-URL Postgres (local dev, a long-lived-process deployment
    // with no pooler in front) needs no extra configuration. Only ever
    // read here, by the Prisma CLI — the running app always connects via
    // DATABASE_URL directly (src/server/db/client.ts), never through this
    // file.
    url: process.env.DIRECT_URL ?? env("DATABASE_URL"),
  },
});
