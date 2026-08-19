import Link from "next/link";

/**
 * Every `EntitlementLimitExceededError` message (src/server/billing/
 * entitlements.ts) ends with this exact phrase — a cheap, dependency-free
 * way for a form's generic `{error: string}` state to recognize "this
 * failure was a plan limit" without importing the error class itself
 * (these forms are Client Components; the error class lives server-side).
 */
export function isEntitlementLimitMessage(message: string): boolean {
  return message.includes("Upgrade the plan to add more.");
}

export function UpgradePlanLink({ orgSlug }: { orgSlug: string }) {
  return (
    <Link href={`/app/${orgSlug}/settings?tab=billing`} className="text-xs font-medium text-primary hover:underline">
      View plans →
    </Link>
  );
}
