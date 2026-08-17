import { describe, expect, it } from "vitest";
import { parseCustomerCsv } from "./customers";

describe("parseCustomerCsv", () => {
  it("normalizes a valid customer CSV into records keyed by canonical field names, independent of column order", () => {
    const csv = "email,phone,name\nacme@example.com,+1 555 0100,Acme Co\nbeta@example.com,,\"Beta, LLC\"\n";
    const result = parseCustomerCsv(csv);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toEqual({
      sourceRow: 1,
      name: "Acme Co",
      email: "acme@example.com",
      phone: "+1 555 0100",
      sourceError: undefined,
    });
    expect(result.records[1]!.name).toBe("Beta, LLC");
    expect(result.records[1]!.email).toBe("beta@example.com");
  });

  it("rejects a file missing the required name column", () => {
    const result = parseCustomerCsv("email,phone\nacme@example.com,555-0100\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("name");
  });

  it("rejects a file missing the required email column", () => {
    const result = parseCustomerCsv("name,phone\nAcme Co,555-0100\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("email");
  });

  it("accepts a file with only the required columns", () => {
    const result = parseCustomerCsv("name,email\nAcme Co,acme@example.com\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records[0]!.name).toBe("Acme Co");
    expect(result.records[0]!.email).toBe("acme@example.com");
    expect(result.records[0]!.phone).toBe("");
  });

  it("parses (but does not itself validate) a row with a blank email — that's the import layer's job", () => {
    // parseCustomerCsv only checks that the *header* is present; per-row
    // content validation (missing/invalid email) happens in
    // importCustomers — see customers.test.ts.
    const result = parseCustomerCsv("name,email\nAcme Co,\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records[0]!.email).toBe("");
  });
});
