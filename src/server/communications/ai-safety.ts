import type { ReminderEmailContext } from "./templates";

export type AiSafetyCheckResult = { safe: true } | { safe: false; reason: string };

type GeneratedContent = { subject: string; body: string };

// Any C0 control character except tab/newline/carriage-return, which are
// legitimate in a multi-line body (CR/LF are handled separately below,
// specifically to explain *why* they're rejected in `subject`).
const DISALLOWED_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const CRLF = /[\r\n]/;

// Matches a currency-symbol- or currency-code-prefixed number — deliberately
// broad (not tied to Intl's exact en-US formatting) so it also catches an
// amount the model wrote in a different format than the one it was given.
const AMOUNT_TOKEN_PATTERN = /(?:[$€£₽]|USD|EUR|RUB)\s?\d[\d,]*\.?\d*/gi;

// ISO date shape only (YYYY-MM-DD) — matches how `dueDate` is formatted in
// DeterministicInvoiceContext (src/server/ar/dates.ts#toDateOnlyString).
// Deliberately does not attempt to parse natural-language dates ("January
// 15th") — see the module doc comment below for why that's an accepted,
// documented limitation rather than an attempt at full NLP date parsing.
const ISO_DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/g;

// A long digit run (bank account, card, phone-shaped) or an IBAN-shaped
// token — the deterministic template never includes anything like this,
// so its presence in AI output is a strong, low-false-positive signal of
// an injected alternate-payment-destination instruction.
const SUSPICIOUS_PAYMENT_TOKEN_PATTERN = /\b\d{10,}\b|\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/;

/**
 * Deterministic, post-generation validation of AI-drafted reminder
 * content against the server-owned facts it was given — see
 * docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1-2/P1-3 for the finding
 * this closes (the AI safety audit proved the pipeline previously
 * accepted *any* string the model returned, validated only for shape,
 * never for truth).
 *
 * Deliberately NOT a second AI call — an LLM "fact-checking" another
 * LLM's output is not a deterministic guardrail, it's a second
 * probabilistic one, and the brief is explicit that the critical checks
 * here must be deterministic. Deliberately NOT a verbatim-prose match
 * either — a reminder email is allowed (expected) to phrase things in its
 * own words; only a few structurally load-bearing facts are checked:
 *
 * - The subject contains no CR/LF (would let a crafted subject inject
 *   extra SMTP headers — see docs/communications.md#email-security; this
 *   check already existed for the *human-edit* path in editing.ts, this
 *   closes the gap on the AI-generation path specifically).
 * - Neither field contains other control characters.
 * - The exact invoice number and exact outstanding amount (as formatted
 *   by formatMoney — same currency, same precision) both appear verbatim
 *   somewhere in the output — proof the AI didn't drop or invent them.
 * - No OTHER currency-shaped amount appears anywhere in the body — closes
 *   the "AI claims a different amount" class of injection.
 * - No OTHER ISO-formatted date contradicts the real due date, when a
 *   date in that recognizable shape is present at all. A natural-language
 *   date claim ("mid-January") is not caught by this — full NLP date
 *   parsing is exactly the "too fragile a check" the brief warns against
 *   building; this is documented as a known limitation, not silently
 *   assumed solved.
 * - No bank-account/IBAN-shaped token appears anywhere — the deterministic
 *   template never includes one, so its presence is a strong signal of an
 *   injected alternate-payment-destination instruction.
 *
 * What this function does NOT need to check, because it is never
 * possible regardless of what the AI writes: recipient, organization
 * identity, and permission-to-send are all resolved server-side before
 * generation even starts (src/server/communications/draft.ts,
 * src/server/communications/channel.ts) and are never read from AI
 * output — see docs/ai-architecture.md#prompt-injection. This function
 * only guards the one thing that genuinely is free text: the message
 * *content*.
 */
export function checkGeneratedReminderSafety(
  content: GeneratedContent,
  facts: ReminderEmailContext,
): AiSafetyCheckResult {
  if (CRLF.test(content.subject)) {
    return { safe: false, reason: "subject contains a line break (CR/LF)" };
  }
  if (DISALLOWED_CONTROL_CHARS.test(content.subject)) {
    return { safe: false, reason: "subject contains a disallowed control character" };
  }
  if (DISALLOWED_CONTROL_CHARS.test(content.body)) {
    return { safe: false, reason: "body contains a disallowed control character" };
  }

  const combined = `${content.subject}\n${content.body}`;

  if (!combined.includes(facts.invoiceNumber)) {
    return { safe: false, reason: "generated content omits the actual invoice number" };
  }
  if (!combined.includes(facts.outstandingAmount)) {
    return { safe: false, reason: "generated content omits the actual outstanding amount" };
  }

  // Conservative by design: a differently-formatted restatement of the
  // SAME value ("USD 500.00" alongside "$500.00") would also trip this
  // and fall back to the deterministic template, even though nothing was
  // actually wrong. That's an acceptable, deliberate false-positive rate
  // — the fallback is a safe, correct email either way, never a
  // customer-facing failure, and erring toward more fallbacks is the
  // right trade-off for a financial-communication safety gate.
  const amountTokens = content.body.match(AMOUNT_TOKEN_PATTERN) ?? [];
  for (const token of amountTokens) {
    if (normalizeAmountToken(token) !== normalizeAmountToken(facts.outstandingAmount)) {
      return { safe: false, reason: "body mentions an amount other than the actual outstanding amount" };
    }
  }

  const dateTokens = content.body.match(ISO_DATE_PATTERN) ?? [];
  for (const token of dateTokens) {
    if (token !== facts.dueDate) {
      return { safe: false, reason: "body mentions a due date other than the actual due date" };
    }
  }

  if (SUSPICIOUS_PAYMENT_TOKEN_PATTERN.test(content.body)) {
    return { safe: false, reason: "body contains a bank-account/IBAN-shaped token not present in the source facts" };
  }

  return { safe: true };
}

/** Loose equality for amount tokens — ignores surrounding whitespace/case/currency-code-vs-symbol differences the regex above can produce, not the underlying numeric value. */
function normalizeAmountToken(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}
