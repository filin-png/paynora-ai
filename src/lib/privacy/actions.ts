"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { COOKIE_CONSENT_COOKIE, isCookieConsentValue } from "./cookie-consent";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Sets the visitor's cookie-consent choice — mirrors
 * src/lib/i18n/actions.ts#setLocaleAction exactly (called directly from a
 * client component, not a <form action>). Silently ignores an
 * unrecognized value rather than throwing.
 */
export async function setCookieConsentAction(value: string): Promise<void> {
  if (!isCookieConsentValue(value)) return;
  const store = await cookies();
  store.set(COOKIE_CONSENT_COOKIE, value, {
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
    sameSite: "lax",
  });
  revalidatePath("/", "layout");
}
