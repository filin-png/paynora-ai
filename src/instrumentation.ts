import * as Sentry from "@sentry/nextjs";

import { env } from "@/lib/env";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Strips the categories of personal data an error event could plausibly
 * carry, before it ever leaves this process for Sentry: the automatic
 * `user` object Sentry attaches from request context, cookies/auth
 * headers/request bodies, and any email address that ended up inside an
 * error message or stack (e.g. "user foo@bar.com not found"). Not a
 * general-purpose DLP system — a deliberately narrow, auditable scrub for
 * the specific PII shapes this codebase's own error paths can produce, so
 * a technical incident ("what broke, where") never doubles as a leak of
 * who was using the product.
 */
function scrubPii(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  delete event.user;
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string;
    if (event.request.headers) {
      delete event.request.headers["authorization"];
      delete event.request.headers["Authorization"];
      delete event.request.headers["cookie"];
      delete event.request.headers["Cookie"];
    }
  }
  if (event.message) event.message = event.message.replace(EMAIL_RE, "[redacted-email]");
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = exception.value.replace(EMAIL_RE, "[redacted-email]");
  }
  return event;
}

/**
 * Server- and edge-runtime error tracking (Sentry) — see
 * docs/production-readiness.md#monitoring, previously "not implemented,
 * contract defined," now real. Next.js calls `register()` once per
 * runtime it instruments this file for (`process.env.NEXT_RUNTIME` tells
 * `@sentry/nextjs` which), so this fires for both "nodejs" and "edge"
 * without any branching here.
 *
 * Deliberately server+edge only, no browser/client SDK: this app has
 * never loaded a client-side third-party script (see next.config.ts's
 * CSP doc comment), and the browser SDK would be the first one — it also
 * reports to Sentry's ingest origin directly from the visitor's browser,
 * which would need a CSP `connect-src` addition to not be silently
 * blocked. That's a real, separate decision, not bundled into this pass.
 *
 * No-op entirely when SENTRY_DSN is unset — see src/lib/env.ts.
 */
export async function register(): Promise<void> {
  if (!env.SENTRY_DSN) return;

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    // Errors only — no performance/trace sampling in this phase, which
    // keeps event volume predictable and comfortably inside Sentry's free
    // tier regardless of traffic.
    tracesSampleRate: 0,
    // The one place PII is actually stripped — deletes any user context,
    // cookies, auth headers and request body the SDK attached, and
    // redacts email-shaped substrings from the error text itself, before
    // the event ever leaves this process.
    beforeSend: scrubPii,
  });
}

/**
 * Captures errors from Server Components/Actions/Route Handlers that
 * Next.js's own error boundary sees but a plain try/catch never would —
 * the documented `@sentry/nextjs` hook for this, see
 * https://nextjs.org/docs/app/building-your-application/configuring/error-handling.
 */
export const onRequestError = Sentry.captureRequestError;
