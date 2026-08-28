/**
 * Formats a minor-unit bigint amount (e.g. wei, 18 decimals) as a decimal
 * string — pure bigint arithmetic throughout, `Number` never touched.
 * This matters specifically for on-chain amounts: `src/server/ar/money.ts`'s
 * `formatMoney` safely round-trips through `Number` for fiat because a
 * minor-unit amount there is bounded by 2 decimals, but a wei amount
 * exceeds `Number.MAX_SAFE_INTEGER` at well under 1 ETH (10^18 wei vs.
 * ~9.007×10^15) — using the same approach for crypto would silently lose
 * precision on any realistic balance. See
 * docs/wallet-architecture.md#decimal-safety.
 */
export function formatAssetAmount(amountMinor: bigint, decimals: number): string {
  const negative = amountMinor < 0n;
  const magnitude = negative ? -amountMinor : amountMinor;
  const base = 10n ** BigInt(decimals);
  const whole = magnitude / base;
  const fraction = magnitude % base;
  const sign = negative ? "-" : "";

  if (fraction === 0n) return `${sign}${whole}`;

  const fractionStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${whole}.${fractionStr}`;
}
