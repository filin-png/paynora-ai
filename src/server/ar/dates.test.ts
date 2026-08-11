import { describe, expect, it } from "vitest";
import { isPastDue, parseDateOnly, toDateOnlyString } from "./dates";

describe("parseDateOnly / toDateOnlyString", () => {
  it("round-trips a calendar date", () => {
    expect(toDateOnlyString(parseDateOnly("2026-08-15"))).toBe("2026-08-15");
  });

  it("rejects a malformed date string", () => {
    expect(() => parseDateOnly("15/08/2026")).toThrow();
  });
});

describe("isPastDue", () => {
  it("is not past due when the due date is in the future", () => {
    expect(isPastDue(parseDateOnly("2026-08-20"), "2026-08-15")).toBe(false);
  });

  it("is not past due when the due date is today", () => {
    expect(isPastDue(parseDateOnly("2026-08-15"), "2026-08-15")).toBe(false);
  });

  it("is past due the day after the due date", () => {
    expect(isPastDue(parseDateOnly("2026-08-14"), "2026-08-15")).toBe(true);
  });

  it("handles a month boundary correctly", () => {
    expect(isPastDue(parseDateOnly("2026-07-31"), "2026-08-01")).toBe(true);
    expect(isPastDue(parseDateOnly("2026-08-01"), "2026-07-31")).toBe(false);
  });

  it("handles a year boundary correctly", () => {
    expect(isPastDue(parseDateOnly("2025-12-31"), "2026-01-01")).toBe(true);
  });
});
