"use server";

import { anonymizeUserAccount } from "@/server/auth/account-deletion";
import { signOut } from "@/server/auth/config";
import { requireUserForPage } from "@/server/tenancy/guards";

/**
 * Account-level, not organization-scoped — operates on whichever user is
 * actually signed in, regardless of which organization's Settings page
 * the request came from. See src/server/auth/account-deletion.ts for
 * what this does and does not touch.
 */
export async function deleteAccountAction(): Promise<void> {
  const user = await requireUserForPage();
  await anonymizeUserAccount(user.id);
  await signOut({ redirectTo: "/" });
}
