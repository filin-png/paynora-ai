import { describe, expect, it } from "vitest";
import { parseInvoiceCsv } from "./invoices";

const HEADER = "invoiceNumber,customerEmail,amount,currency,issueDate,dueDate";

describe("parseInvoiceCsv", () => {
  it("normalizes a valid invoice CSV into records keyed by canonical field names", () => {
    const csv = `${HEADER}\nINV-0001,acme@example.com,1500.25,USD,2026-01-01,2026-01-15\n`;
    const result = parseInvoiceCsv(csv);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records[0]).toEqual({
      sourceRow: 1,
      invoiceNumber: "INV-0001",
      customerEmail: "acme@example.com",
      amount: "1500.25",
      currency: "USD",
      issueDate: "2026-01-01",
      dueDate: "2026-01-15",
      sourceError: undefined,
    });
  });

  it("rejects a file missing a required column", () => {
    const result = parseInvoiceCsv("invoiceNumber,customerEmail,amount\nINV-1,a@example.com,100\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("currency");
  });

  it("works with columns in a different order than the documented format", () => {
    const csv = "dueDate,issueDate,currency,amount,customerEmail,invoiceNumber\n2026-01-15,2026-01-01,USD,100.00,acme@example.com,INV-1\n";
    const result = parseInvoiceCsv(csv);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records[0]!.invoiceNumber).toBe("INV-1");
    expect(result.records[0]!.amount).toBe("100.00");
  });
});
