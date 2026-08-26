"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { isSupportedLocale, LOCALE_COOKIE } from "./config";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Sets the persisted locale and revalidates every layout so the change is
 * visible on the very next render — called directly from the client
 * LocaleSwitcher component (src/components/locale-switcher.tsx), not via
 * a <form action>, since it needs no other form data. Silently ignores an
 * unrecognized locale value rather than throwing — this is a UI
 * preference, not a security boundary.
 */
export async function setLocaleAction(locale: string): Promise<void> {
  if (!isSupportedLocale(locale)) return;
  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
    sameSite: "lax",
  });
  revalidatePath("/", "layout");
}
