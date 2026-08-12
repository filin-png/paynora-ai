#!/usr/bin/env tsx
/**
 * PAYNORA live smoke test — a dev-only, manual, side-effect-aware CLI for
 * verifying that a *real* configured provider actually works, against the
 * real vendor, with real credentials. See docs/integration-architecture.md
 * #live-smoke-test.
 *
 * This is deliberately NOT part of `npm run test` or CI: it makes real
 * network calls against real vendor accounts, using whatever credentials
 * are in the local environment. Nothing in this codebase's automated test
 * suite, application code, or CI workflow ever imports or invokes this
 * file — see the guard immediately below for the enforcement of that.
 *
 * Usage:
 *   npm run smoke -- ai openrouter --confirm
 *   npm run smoke -- ai mistral --confirm
 *   npm run smoke -- email --to=you@example.com --confirm
 *   npm run smoke -- telegram --to=<chat-id> --confirm
 *
 * Every target requires --confirm — there is no default recipient and no
 * implicit send. Nothing here prints a secret: API keys, bot tokens, and
 * SMTP passwords are read from the environment and used, never echoed.
 */
import { config as loadEnv } from "dotenv";

// Same "fill in what's missing, never override a real value" pattern as
// prisma.config.ts, so this reads the same .env.local/.env Next.js does.
loadEnv({ path: ".env.local" });
loadEnv();

function fail(message: string): never {
  console.error(`[smoke] ${message}`);
  process.exit(1);
}

// Refuse to run anywhere that isn't an interactive developer's own
// machine — this must never run unattended, in CI, or inside the test
// runner, since every target here makes a real vendor call.
if (process.env.CI === "true" || process.env.CI === "1") {
  fail("refusing to run: CI environment detected. This script is dev-only and never runs in CI.");
}
if (process.env.VITEST) {
  fail("refusing to run: invoked from inside the Vitest runner. This script is not a test.");
}

type Target = "ai" | "email" | "telegram";

function parseArgs(argv: string[]): {
  target: Target;
  vendor?: string;
  to?: string;
  confirm: boolean;
} {
  const [target, ...rest] = argv;
  if (target !== "ai" && target !== "email" && target !== "telegram") {
    fail(`unknown target ${JSON.stringify(target)} — expected "ai", "email", or "telegram".`);
  }

  let vendor: string | undefined;
  let to: string | undefined;
  let confirm = false;

  for (const arg of rest) {
    if (arg === "--confirm") {
      confirm = true;
    } else if (arg.startsWith("--to=")) {
      to = arg.slice("--to=".length).trim();
    } else if (target === "ai" && !arg.startsWith("--")) {
      vendor = arg;
    } else {
      fail(`unrecognized argument ${JSON.stringify(arg)}.`);
    }
  }

  return { target, vendor, to, confirm };
}

async function runAiSmoke(vendor: string | undefined, confirm: boolean): Promise<void> {
  if (vendor !== "openrouter" && vendor !== "mistral") {
    fail('ai target requires a vendor: "openrouter" or "mistral" — e.g. `npm run smoke -- ai openrouter --confirm`.');
  }
  if (!confirm) {
    fail("refusing to call a real AI vendor without --confirm.");
  }

  const { openRouterProvider } = await import("../src/server/ai/providers/openrouter");
  const { mistralProvider } = await import("../src/server/ai/providers/mistral");
  const { runAIGeneration } = await import("../src/server/ai/gateway");
  const { buildReminderEmailRequest } = await import("../src/server/communications/ai-context");

  const provider = vendor === "openrouter" ? openRouterProvider : mistralProvider;

  // Fixed, synthetic invoice data — never anything drawn from a real
  // customer or a real database. Exercises the exact same request-shaping
  // path production drafting uses (buildReminderEmailRequest), so a
  // passing smoke test genuinely proves the wire contract works.
  const request = buildReminderEmailRequest({
    invoiceNumber: "SMOKE-TEST-0001",
    currency: "USD",
    outstandingAmount: "$1.00",
    dueDate: "2020-01-01",
    daysOverdue: 1,
    customerName: "Smoke Test Customer",
    organizationName: "PAYNORA Live Smoke Test",
  });

  console.info(`[smoke] calling ${vendor} for real — this uses a real API key and counts against real quota...`);
  const result = await runAIGeneration(provider, request, { timeoutMs: 30_000 });

  // Only ever print the schema-validated, structured result — never the
  // system prompt, never a raw response body, never a header or key.
  console.info(`[smoke] ${vendor} OK — provider=${result.provider}`);
  console.info(`[smoke] subject: ${result.data.subject}`);
  console.info(`[smoke] body length: ${result.data.body.length} chars`);
  if (result.usage) console.info(`[smoke] usage: ${JSON.stringify(result.usage)}`);
}

async function runEmailSmoke(to: string | undefined, confirm: boolean): Promise<void> {
  if (!to) fail("email target requires --to=<address> — there is no default recipient.");
  if (!confirm) fail("refusing to send a real email without --confirm.");

  const { resolveEmailProvider, getSenderAddress } = await import("../src/server/email/service");
  const { dispatchEmail } = await import("../src/server/email/gateway");

  const provider = resolveEmailProvider();
  const from = getSenderAddress();

  console.info(`[smoke] sending a real email via ${provider.name} to the address you supplied...`);
  const result = await dispatchEmail(provider, {
    to,
    from,
    subject: "PAYNORA live smoke test — safe to ignore",
    text: "This is a manual PAYNORA live smoke test message, sent by scripts/live-smoke-test.ts. No action is needed.",
    idempotencyKey: `smoke-test-${Date.now()}`,
  });

  console.info(`[smoke] email OK — provider=${result.provider}${result.providerMessageId ? ` providerMessageId=${result.providerMessageId}` : ""}`);
}

async function runTelegramSmoke(to: string | undefined, confirm: boolean): Promise<void> {
  if (!to) fail("telegram target requires --to=<chat id> — there is no default recipient.");
  if (!confirm) fail("refusing to send a real Telegram message without --confirm.");

  const { resolveMessagingProvider } = await import("../src/server/messaging/service");
  const { dispatchMessage } = await import("../src/server/messaging/gateway");

  const provider = resolveMessagingProvider();

  console.info(`[smoke] sending a real Telegram message via ${provider.name} to the chat id you supplied...`);
  const result = await dispatchMessage(provider, {
    to,
    text: "This is a manual PAYNORA live smoke test message, sent by scripts/live-smoke-test.ts. No action is needed.",
    idempotencyKey: `smoke-test-${Date.now()}`,
  });

  console.info(`[smoke] telegram OK — provider=${result.provider}${result.providerMessageId ? ` providerMessageId=${result.providerMessageId}` : ""}`);
}

async function main(): Promise<void> {
  const { target, vendor, to, confirm } = parseArgs(process.argv.slice(2));

  if (target === "ai") await runAiSmoke(vendor, confirm);
  else if (target === "email") await runEmailSmoke(to, confirm);
  else await runTelegramSmoke(to, confirm);
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  // Never print `error` itself — some thrown values (e.g. a raw fetch
  // Response-derived error) could carry more than the normalized
  // name/message this codebase's provider errors deliberately expose.
  console.error(`[smoke] FAILED: ${name}: ${message}`);
  process.exit(1);
});
