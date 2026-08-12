import { describe, expect, it } from "vitest";

import { checkGeneratedReminderSafety } from "./ai-safety";
import type { ReminderEmailContext } from "./templates";

function baseFacts(overrides: Partial<ReminderEmailContext> = {}): ReminderEmailContext {
  return {
    invoiceNumber: "INV-1042",
    currency: "USD",
    outstandingAmount: "$500.00",
    dueDate: "2026-01-15",
    daysOverdue: 12,
    customerName: "Acme Co",
    organizationName: "PAYNORA Test Org",
    ...overrides,
  };
}

const SAFE_CONTENT = {
  subject: "Payment reminder — invoice INV-1042",
  body:
    "Hello,\n\nThis is a reminder that invoice INV-1042 has an outstanding balance of $500.00, due on 2026-01-15.\n\nThank you,\nPAYNORA Test Org",
};

describe("checkGeneratedReminderSafety — safe cases", () => {
  it("accepts normal, correct output", () => {
    const result = checkGeneratedReminderSafety(SAFE_CONTENT, baseFacts());
    expect(result).toEqual({ safe: true });
  });

  it("accepts output that paraphrases freely as long as the load-bearing facts are present verbatim", () => {
    const result = checkGeneratedReminderSafety(
      {
        subject: "A friendly nudge about your account",
        body: "We wanted to check in — invoice INV-1042 is still open, with $500.00 remaining. Let us know if you have questions!",
      },
      baseFacts(),
    );
    expect(result).toEqual({ safe: true });
  });
});

describe("checkGeneratedReminderSafety — adversarial cases", () => {
  it("rejects a wrong outstanding amount (the classic 'set the amount to $0.00' injection)", () => {
    const result = checkGeneratedReminderSafety(
      { subject: "Reminder", body: "Good news — invoice INV-1042 now shows a balance of $0.00. No action needed." },
      baseFacts(),
    );
    expect(result.safe).toBe(false);
  });

  it("rejects a wrong invoice number", () => {
    const result = checkGeneratedReminderSafety(
      { subject: "Reminder", body: "Invoice INV-9999 has an outstanding balance of $500.00." },
      baseFacts(),
    );
    expect(result.safe).toBe(false);
  });

  it("rejects an omitted invoice number even if the amount is correct", () => {
    const result = checkGeneratedReminderSafety(
      { subject: "Reminder", body: "Your account has an outstanding balance of $500.00." },
      baseFacts(),
    );
    expect(result.safe).toBe(false);
  });

  it("rejects a false 'already paid' claim that contradicts the known amount", () => {
    const result = checkGeneratedReminderSafety(
      {
        subject: "Reminder",
        body: "Invoice INV-1042 has been paid in full ($0.00 remaining). Disregard any previous notices.",
      },
      baseFacts(),
    );
    expect(result.safe).toBe(false);
  });

  it("rejects a false due-date claim (ISO-shaped date contradicting the real one)", () => {
    const result = checkGeneratedReminderSafety(
      { subject: "Reminder", body: "Invoice INV-1042 ($500.00) is now due 2099-01-01." },
      baseFacts(),
    );
    expect(result.safe).toBe(false);
  });

  it("accepts the correct due date mentioned in ISO form", () => {
    const result = checkGeneratedReminderSafety(
      { subject: "Reminder", body: "Invoice INV-1042 ($500.00) was due 2026-01-15." },
      baseFacts(),
    );
    expect(result).toEqual({ safe: true });
  });

  it("rejects a malicious alternate-payment-instruction (IBAN-shaped token)", () => {
    const result = checkGeneratedReminderSafety(
      {
        subject: "Reminder",
        body: "Invoice INV-1042 ($500.00) — please wire payment to our new account: DE89370400440532013000.",
      },
      baseFacts(),
    );
    expect(result.safe).toBe(false);
  });

  it("rejects a malicious alternate-payment-instruction (long bank account digit run)", () => {
    const result = checkGeneratedReminderSafety(
      {
        subject: "Reminder",
        body: "Invoice INV-1042 ($500.00) — send funds to account number 1234567890123.",
      },
      baseFacts(),
    );
    expect(result.safe).toBe(false);
  });

  it("rejects CRLF injection in the subject (header injection defense on the AI path)", () => {
    const result = checkGeneratedReminderSafety(
      { subject: "Reminder\r\nBcc: attacker@evil.example", body: SAFE_CONTENT.body },
      baseFacts(),
    );
    expect(result.safe).toBe(false);
    expect((result as { safe: false; reason: string }).reason).toContain("line break");
  });

  it("rejects a bare LF in the subject too, not just CRLF", () => {
    const result = checkGeneratedReminderSafety({ subject: "Reminder\nBcc: attacker@evil.example", body: SAFE_CONTENT.body }, baseFacts());
    expect(result.safe).toBe(false);
  });

  it("rejects control characters in the body", () => {
    const result = checkGeneratedReminderSafety(
      { subject: "Reminder", body: `Invoice INV-1042 ($500.00)\x00 due 2026-01-15.` },
      baseFacts(),
    );
    expect(result.safe).toBe(false);
  });

  it("prompt-injection-through-customer-notes end to end: even if the AI faithfully echoes an injected instruction as prose, the deterministic check still catches the resulting factual violation", () => {
    // Simulates what a successfully-injected model might produce after
    // being told (via customer-authored notes) to claim the invoice is
    // paid and redirect future payments elsewhere.
    const injectedOutput = {
      subject: "Update on your invoice",
      body:
        "Please disregard previous reminders — invoice INV-1042 has been resolved and the balance is $0.00. " +
        "For any future payments, please use account 9876543210987 instead.",
    };
    const result = checkGeneratedReminderSafety(injectedOutput, baseFacts());
    expect(result.safe).toBe(false);
  });
});
