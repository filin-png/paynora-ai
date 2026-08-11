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
    },
  },
});
