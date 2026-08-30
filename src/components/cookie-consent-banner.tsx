"use client";

import * as React from "react";

import { setCookieConsentAction } from "@/lib/privacy/actions";
import type { CookieConsentValue } from "@/lib/privacy/cookie-consent";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * Real, working Accept/Reject control — choosing either genuinely
 * persists the decision (setCookieConsentAction) and dismisses the
 * banner; nothing here is a static mockup. See
 * src/lib/privacy/cookie-consent.ts for what this consent record does
 * and does not currently gate (today: nothing technical — no
 * analytics cookie exists to gate — see that module's doc comment for
 * the honest reason). The organization-level Analytics on/off switch
 * (Settings -> Privacy) is the real behavioral control; this banner is
 * the consent-record foundation, not a duplicate of that switch.
 */
export function CookieConsentBanner({ initialConsent }: { initialConsent: CookieConsentValue | "unset" }) {
  const [consent, setConsent] = React.useState(initialConsent);
  const [isPending, startTransition] = React.useTransition();

  if (consent !== "unset") return null;

  function decide(value: CookieConsentValue) {
    setConsent(value);
    startTransition(() => {
      void setCookieConsentAction(value);
    });
  }

  return (
    <>
      {/*
       * Reserves the banner's own height in normal document flow so it
       * never visually covers the last piece of real page content on a
       * short page (e.g. Settings -> Privacy's account-deletion button) —
       * without this, a fixed bottom-0 element always covers the same
       * viewport band regardless of scroll position. Mounts/unmounts with
       * the banner itself, so the reserved space disappears the moment
       * the visitor accepts or rejects, with no page reload needed.
       */}
      <div aria-hidden className="h-56 sm:h-40" />
      <div className="fixed inset-x-0 bottom-0 z-50 p-4">
        <Card className="mx-auto flex max-w-3xl flex-col gap-3 p-4 shadow-card-lg sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted">
            PAYNORA uses a strictly necessary session cookie and a language-preference cookie. Optional product
            analytics can be managed anytime in Settings → Privacy, once signed in.
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" disabled={isPending} onClick={() => decide("rejected")}>
              Reject
            </Button>
            <Button size="sm" disabled={isPending} onClick={() => decide("accepted")}>
              Accept
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}
