#!/usr/bin/env tsx
/**
 * PAYNORA production readiness gate — Phase 23, see
 * docs/production-readiness.md#automated-production-gate.
 *
 * A single command (`npm run production:check`) that runs every
 * automatically-checkable production-readiness condition this codebase
 * can verify without a real deployment, a real domain, or any real
 * vendor credential. It deliberately never makes an external network
 * call — the one thing in this codebase that does (`npm run smoke`,
 * `scripts/live-smoke-test.ts`) already requires its own explicit
 * `--confirm` flag and refuses to run in CI/under Vitest; this script
 * follows the same principle for the same reason, and reuses that
 * script's guard rather than inventing a second one.
 *
 * Stages, run in order, each printed separately (so a failure clearly
 * names which stage broke) — stops at the first failure:
 *   1. static        — lint + typecheck (existing `npm run lint`/`typecheck`)
 *   2. configuration — this deployment's current env, parsed by the same
 *                       schema the running app itself uses (`@/lib/env`);
 *                       never requires a credential for a provider this
 *                       deployment hasn't selected, and never invents one
 *   3. database      — `prisma validate` (existing `npm run db:validate`)
 *   4. security      — .env.example never contains a real-looking secret
 *                       value, and next.config.ts still declares its
 *                       security headers (a cheap regression guard, not a
 *                       re-implementation of the headers themselves)
 *   5. test suite    — `npm test` (existing, already has no external
 *                       network dependency — see vitest.config.mts)
 *   6. build         — `npm run build`
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

let stageNumber = 0;

async function stage(name: string, run: () => void | Promise<void>): Promise<void> {
  stageNumber += 1;
  console.log(`\n[production:check] Stage ${stageNumber}: ${name}`);
  try {
    await run();
    console.log(`[production:check] Stage ${stageNumber} (${name}): OK`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[production:check] Stage ${stageNumber} (${name}) FAILED: ${message}`);
    process.exit(1);
  }
}

function runCommand(command: string): void {
  execSync(command, { stdio: "inherit" });
}

/**
 * Every one of these is a real secret-shaped key this codebase's env
 * schema recognizes (src/lib/env.ts) — .env.example must document them as
 * present-but-empty (`KEY=` with nothing after it, or commented out
 * entirely), never with a real-looking value. This is a regression guard
 * for an invariant this codebase has maintained by hand since Phase 1,
 * not a generic secret scanner.
 */
const ENV_EXAMPLE_SECRET_KEYS = [
  "AUTH_SECRET",
  "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY",
  "SMTP_PASSWORD",
  "AUTOMATION_CRON_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "YUKASSA_SECRET_KEY",
  "WALLET_WEBHOOK_SECRET",
  "ALCHEMY_API_KEY",
  "ALCHEMY_AUTH_TOKEN",
  "ALCHEMY_WEBHOOK_SIGNING_KEY",
  "POSTHOG_API_KEY",
  "ANTHROPIC_API_KEY",
];

function checkEnvExampleHasNoRealSecrets(): void {
  const envExample = readFileSync(".env.example", "utf8");
  for (const line of envExample.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed === "") continue;
    const [key, ...rest] = trimmed.split("=");
    const value = rest.join("=").trim();
    if (key && ENV_EXAMPLE_SECRET_KEYS.includes(key) && value.length > 0) {
      throw new Error(`.env.example sets a real-looking value for ${key} — it must stay empty or commented out`);
    }
  }
}

function checkSecurityHeadersStillDeclared(): void {
  const nextConfig = readFileSync("next.config.ts", "utf8");
  if (!nextConfig.includes("Content-Security-Policy")) {
    throw new Error(
      "next.config.ts no longer declares a Content-Security-Policy header — see docs/production-readiness.md#security-headers",
    );
  }
}

async function main(): Promise<void> {
  await stage("static (lint + typecheck)", () => {
    runCommand("npm run lint");
    runCommand("npm run typecheck");
  });

  await stage("configuration (env schema, this deployment's current environment)", async () => {
    // Dynamic import so a config error here is caught and reported by
    // this script's own stage() wrapper (a plain top-level `import`
    // would throw before any stage output printed at all — because
    // `src/lib/env.ts` parses and exports `env` at module load — before
    // this script even got the chance to say which stage that was).
    await import("../src/lib/env");
  });

  await stage("database (prisma validate)", () => {
    runCommand("npm run db:validate");
  });

  await stage("security (config file regressions)", () => {
    checkEnvExampleHasNoRealSecrets();
    checkSecurityHeadersStillDeclared();
  });

  await stage("test suite", () => {
    runCommand("npm test");
  });

  await stage("build", () => {
    runCommand("npm run build");
  });

  console.log("\n[production:check] All stages passed.");
}

main();
