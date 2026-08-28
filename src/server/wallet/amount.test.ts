import { describe, expect, it } from "vitest";

import { formatAssetAmount } from "./amount";

describe("formatAssetAmount", () => {
  it("formats exactly 1 ETH (10^18 wei) with no trailing fraction", () => {
    expect(formatAssetAmount(1_000_000_000_000_000_000n, 18)).toBe("1");
  });

  it("formats a fractional amount exactly (1.5 ETH)", () => {
    expect(formatAssetAmount(1_500_000_000_000_000_000n, 18)).toBe("1.5");
  });

  it("formats zero", () => {
    expect(formatAssetAmount(0n, 18)).toBe("0");
  });

  it("formats the smallest possible unit (1 wei) without rounding to zero", () => {
    expect(formatAssetAmount(1n, 18)).toBe("0.000000000000000001");
  });

  it("preserves full precision on an amount that exceeds Number.MAX_SAFE_INTEGER", () => {
    // 1,000,000.123456789012345678 ETH — chosen so the fractional part alone
    // would already be mangled by a float round-trip.
    const wholePart = 1_000_000n * 10n ** 18n;
    const fractionalPart = 123456789012345678n;
    const amountMinor = wholePart + fractionalPart;

    expect(amountMinor > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(formatAssetAmount(amountMinor, 18)).toBe("1000000.123456789012345678");
  });

  it("formats a negative amount with the sign preserved", () => {
    expect(formatAssetAmount(-1_500_000_000_000_000_000n, 18)).toBe("-1.5");
  });

  it("respects a different decimals value (e.g. a 6-decimal token)", () => {
    expect(formatAssetAmount(1_500_000n, 6)).toBe("1.5");
  });

  it("never produces a string containing a floating-point rounding artifact", () => {
    // 0.1 + 0.2 in IEEE-754 float famously produces 0.30000000000000004 —
    // the equivalent bigint computation must not.
    const result = formatAssetAmount(300_000_000_000_000_000n, 18);
    expect(result).toBe("0.3");
    expect(result).not.toContain("0000000000000004");
  });
});
