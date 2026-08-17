import { describe, expect, it } from "vitest";
import { MAX_IMPORT_ROWS } from "../limits";
import { parseCsvText } from "./parse";

describe("parseCsvText", () => {
  it("parses a well-formed CSV into header-keyed rows", () => {
    const result = parseCsvText("name,email\nAcme,acme@example.com\nBeta,beta@example.com\n");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headers).toEqual(["name", "email"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({ rowNumber: 1, fields: { name: "Acme", email: "acme@example.com" }, parseError: undefined });
    expect(result.rows[1]!.fields.name).toBe("Beta");
  });

  it("rejects an empty file", () => {
    const result = parseCsvText("");
    expect(result).toEqual({ ok: false, reason: "The file is empty." });
  });

  it("rejects a file with only whitespace", () => {
    const result = parseCsvText("   \n  \n");
    expect(result.ok).toBe(false);
  });

  it("handles quoted fields containing commas and embedded newlines correctly", () => {
    const csv = 'name,notes\n"Acme, Inc.","Line one\nLine two"\n';
    const result = parseCsvText(csv);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]!.fields.name).toBe("Acme, Inc.");
    expect(result.rows[0]!.fields.notes).toBe("Line one\nLine two");
  });

  it("trims whitespace from header names", () => {
    const result = parseCsvText(" name , email \nAcme,acme@example.com\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headers).toEqual(["name", "email"]);
  });

  it("attaches a per-row parse error to a malformed row without rejecting the whole file", () => {
    // Row 2 has one field too many for the two-column header — a real-world
    // "someone typed an extra comma" mistake, not a structural file problem.
    const csv = "name,email\nGood Row,good@example.com\nBad Row,bad@example.com,extra\nAnother Good,another@example.com\n";
    const result = parseCsvText(csv);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]!.parseError).toBeUndefined();
    expect(result.rows[1]!.parseError).toBeDefined();
    expect(result.rows[2]!.parseError).toBeUndefined();
  });

  it("rejects a file with more rows than MAX_IMPORT_ROWS", () => {
    const header = "name\n";
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `Customer ${i}`).join("\n");
    const result = parseCsvText(header + rows);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(String(MAX_IMPORT_ROWS));
  });

  it("accepts exactly MAX_IMPORT_ROWS rows", () => {
    const header = "name\n";
    const rows = Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => `Customer ${i}`).join("\n");
    const result = parseCsvText(header + rows);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(MAX_IMPORT_ROWS);
  });
});
