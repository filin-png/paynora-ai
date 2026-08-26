"use client";

import * as React from "react";

import { setLocaleAction } from "@/lib/i18n/actions";
import { SUPPORTED_LOCALES, type Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

const LOCALE_LABEL: Record<Locale, string> = { en: "EN", ru: "RU" };

/**
 * Real, working language switcher — calling setLocaleAction (a Server
 * Action) sets the persisted locale cookie and revalidates every layout,
 * so the next render genuinely reflects the new locale; this is not a
 * decorative toggle. See docs/production-integrations.md#internationalization-status
 * for exactly which parts of the UI respond to it today.
 */
export function LocaleSwitcher({ locale, dark = false }: { locale: Locale; dark?: boolean }) {
  const [isPending, startTransition] = React.useTransition();

  function switchTo(next: Locale) {
    if (next === locale || isPending) return;
    startTransition(() => {
      void setLocaleAction(next);
    });
  }

  return (
    <div
      role="group"
      aria-label="Language"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full border p-0.5 text-xs font-medium",
        dark ? "border-white/15 text-navy-muted" : "border-border text-muted-foreground",
      )}
    >
      {SUPPORTED_LOCALES.map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => switchTo(value)}
          aria-pressed={locale === value}
          disabled={isPending}
          className={cn(
            "rounded-full px-2 py-0.5 transition-colors disabled:opacity-60",
            locale === value
              ? dark
                ? "bg-white/15 text-white"
                : "bg-accent-soft text-primary"
              : dark
                ? "hover:text-white"
                : "hover:text-foreground",
          )}
        >
          {LOCALE_LABEL[value]}
        </button>
      ))}
    </div>
  );
}
