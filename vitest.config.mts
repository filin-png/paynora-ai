import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration tests share one Postgres test database and reset it
    // between tests; running test files in parallel would let them
    // truncate each other's fixtures mid-assertion.
    fileParallelism: false,
    // Integration tests hit a real Postgres database — see
    // docs/identity-and-tenancy.md#testing. Deliberately a distinct
    // database from the one `npm run dev` uses (defaults to
    // `paynora_test` vs. `paynora`), since tests truncate tables between
    // runs. Override TEST_DATABASE_URL in CI or to point at a different
    // local database.
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgresql://paynora:paynora@localhost:5432/paynora_test?schema=public",
      AUTH_SECRET: "test-only-secret-do-not-use-in-production-00000",
      // EMAIL_PROVIDER is deliberately left unset (defaults to "none") so
      // the suite never makes a real email network call. PAYNORA_EMAIL_FROM
      // is set so src/server/communications/send.test.ts can exercise
      // sendCommunication's real sender-resolution path while injecting a
      // deterministic fake EmailProvider for the "send" step itself — see
      // send.ts's `provider` test-only option.
      PAYNORA_EMAIL_FROM: "billing@paynora-test.example",
      // Ambient default so runAutomationTick's real logic runs in tests
      // without every call needing to override it — mirrors how
      // AUTH_SECRET/PAYNORA_EMAIL_FROM are always set for tests even though
      // production requires an explicit operator choice. The one test that
      // needs AUTOMATION_ENABLED=false uses runAutomationTick's `now`-style
      // dependency-injected override (see src/server/collections/engine.ts)
      // rather than re-parsing env, since env is a load-time singleton.
      AUTOMATION_ENABLED: "true",
      AUTOMATION_CRON_SECRET: "test-only-automation-cron-secret-00000",
    },
  },
});
