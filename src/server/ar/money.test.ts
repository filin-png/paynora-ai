import { describe, expect, it } from "vitest";
import { amountMinorSchema, formatMoney, majorToMinor, minorToMajorString, parseAmountInput } from "./money";

// Well beyond the old Int32 ceiling (2,147,483,647) this project
// deliberately moved away from — see docs/accounts-receivable.md.
const BEYOND_INT32 = 50_000_000_000n; // 500,000,000.00 in major units
const HUGE_AMOUNT = 99_999_999_999_999n; // ~1 trillion major units

describe("majorToMinor", () => {
  it("converts major currency units to minor units", () => {
    expect(majorToMinor(100)).toBe(10_000n);
    expect(majorToMinor(1.5)).toBe(150n);
  });
});

describe("amountMinorSchema", () => {
  it("accepts a positive bigint", () => {
    expect(amountMinorSchema.parse(10_000n)).toBe(10_000n);
  });

  it("accepts an amount far beyond the old Int32 ceiling", () => {
    expect(amountMinorSchema.parse(BEYOND_INT32)).toBe(BEYOND_INT32);
  });

  it("rejects zero", () => {
    expect(() => amountMinorSchema.parse(0n)).toThrow();
  });

  it("rejects negative amounts", () => {
    expect(() => amountMinorSchema.parse(-100n)).toThrow();
  });

  it("rejects an amount beyond the Postgres BIGINT ceiling", () => {
    expect(() => amountMinorSchema.parse(9_223_372_036_854_775_808n)).toThrow();
  });
});

describe("parseAmountInput", () => {
  it("parses a whole number amount", () => {
    expect(parseAmountInput("1500")).toBe(150_000n);
  });

  it("parses a two-decimal amount", () => {
    expect(parseAmountInput("19.99")).toBe(1_999n);
  });

  it("parses a one-decimal amount", () => {
    expect(parseAmountInput("19.9")).toBe(1_990n);
  });

  it("parses a large amount exactly, with no floating point involved", () => {
    expect(parseAmountInput("500000000.00")).toBe(BEYOND_INT32);
    expect(parseAmountInput("999999999999.99")).toBe(99_999_999_999_999n);
  });

  it("rejects more than two decimal places", () => {
    expect(() => parseAmountInput("19.999")).toThrow();
  });

  it("rejects a negative amount", () => {
    expect(() => parseAmountInput("-5")).toThrow();
  });

  it("rejects non-numeric input", () => {
    expect(() => parseAmountInput("abc")).toThrow();
  });

  it("rejects empty input", () => {
    expect(() => parseAmountInput("")).toThrow();
  });
});

describe("formatMoney", () => {
  it("formats minor units as a currency string", () => {
    expect(formatMoney(10_000n, "USD")).toBe("$100.00");
    expect(formatMoney(150n, "USD")).toBe("$1.50");
  });

  it("formats an amount well beyond the old Int32 ceiling", () => {
    expect(formatMoney(BEYOND_INT32, "USD")).toBe("$500,000,000.00");
  });

  it("formats a huge amount within the safe-integer range", () => {
    expect(formatMoney(HUGE_AMOUNT, "USD")).toBe("$999,999,999,999.99");
  });

  it("throws rather than silently losing precision beyond Number.MAX_SAFE_INTEGER", () => {
    const tooLarge = BigInt(Number.MAX_SAFE_INTEGER) + 100n;
    expect(() => formatMoney(tooLarge, "USD")).toThrow();
  });
});

describe("minorToMajorString", () => {
  it("formats a plain decimal string with no currency symbol or separators", () => {
    expect(minorToMajorString(150_000n)).toBe("1500.00");
  });

  it("pads a single-digit fraction to two decimal places", () => {
    expect(minorToMajorString(1_005n)).toBe("10.05");
  });

  it("formats zero", () => {
    expect(minorToMajorString(0n)).toBe("0.00");
  });

  it("formats a negative amount with a leading minus, not a trailing one", () => {
    expect(minorToMajorString(-1_999n)).toBe("-19.99");
  });

  it("round-trips through parseAmountInput for an arbitrary decimal", () => {
    const minor = parseAmountInput("999999999999.99");
    expect(minorToMajorString(minor)).toBe("999999999999.99");
  });

  it("is exact well beyond Number.MAX_SAFE_INTEGER, where formatMoney refuses to run", () => {
    const beyondSafeInteger = BigInt(Number.MAX_SAFE_INTEGER) + 12_345n;
    expect(() => formatMoney(beyondSafeInteger, "USD")).toThrow();
    expect(minorToMajorString(beyondSafeInteger)).toBe("90071992547533.36");
  });
});
