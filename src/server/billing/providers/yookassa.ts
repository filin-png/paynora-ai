import { minorToMajorString, parseAmountInput } from "@/server/ar/money";
import { BillingWebhookVerificationError } from "../errors";
import type {
  BillingPaymentId,
  BillingProvider,
  BillingSubscriptionStatus,
  CheckoutSession,
  CreateCheckoutInput,
  NormalizedSubscriptionEvent,
  WebhookVerificationContext,
} from "../types";

const API_BASE = "https://api.yookassa.ru/v3";
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * YooKassa verifies webhook authenticity by source-IP allowlist, not a
 * signature header (confirmed against YooKassa's own published
 * documentation, docs/billing-provider.md#webhook-authenticity — there is
 * no `X-YooKassa-Signature` or equivalent). These CIDR blocks are the
 * ranges YooKassa documents as of Phase 20; overridable via
 * `YUKASSA_WEBHOOK_IP_ALLOWLIST` (comma-separated CIDRs) since a vendor's
 * IP ranges can change — re-verify at
 * https://yookassa.ru/developers/using-api/webhooks before relying on
 * this list in production.
 */
export const DEFAULT_ALLOWED_CIDRS = [
  "185.71.76.0/27",
  "185.71.77.0/27",
  "77.75.153.0/25",
  "77.75.156.11/32",
  "77.75.156.35/32",
  "77.75.154.128/25",
  "2a02:5180::/32",
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    result = (result << 8) | value;
  }
  return result >>> 0;
}

function isIpv4InCidr(ip: string, cidr: string): boolean {
  const [network, prefixRaw] = cidr.split("/");
  const prefix = Number(prefixRaw);
  const ipInt = ipv4ToInt(ip);
  const networkInt = ipv4ToInt(network!);
  if (ipInt === null || networkInt === null || Number.isNaN(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (networkInt & mask);
}

/** Expands an IPv6 address (including `::` shorthand) into its full 128-bit value as a BigInt, or null if malformed. */
function ipv6ToBigInt(ip: string): bigint | null {
  const withoutZone = ip.split("%")[0]!;
  const [head, tail] = withoutZone.includes("::") ? withoutZone.split("::") : [withoutZone, undefined];
  const headGroups = head ? head.split(":").filter((g) => g.length > 0) : [];
  const tailGroups = tail ? tail.split(":").filter((g) => g.length > 0) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (!withoutZone.includes("::") && headGroups.length !== 8) return null;
  if (withoutZone.includes("::") && missing < 0) return null;
  const allGroups = [...headGroups, ...Array(withoutZone.includes("::") ? missing : 0).fill("0"), ...tailGroups];
  if (allGroups.length !== 8) return null;
  let result = 0n;
  for (const group of allGroups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    result = (result << 16n) | BigInt(parseInt(group, 16));
  }
  return result;
}

function isIpv6InCidr(ip: string, cidr: string): boolean {
  const [network, prefixRaw] = cidr.split("/");
  const prefix = Number(prefixRaw);
  const ipValue = ipv6ToBigInt(ip);
  const networkValue = ipv6ToBigInt(network!);
  if (ipValue === null || networkValue === null || Number.isNaN(prefix) || prefix < 0 || prefix > 128) return false;
  const shift = BigInt(128 - prefix);
  const mask = shift === 0n ? (1n << 128n) - 1n : ((1n << 128n) - 1n) - ((1n << shift) - 1n);
  return (ipValue & mask) === (networkValue & mask);
}

/** Exported for tests — real IP-allowlist logic, not a stubbed check. */
export function isIpAllowed(ip: string, cidrs: readonly string[]): boolean {
  const trimmed = ip.trim();
  for (const cidr of cidrs) {
    if (cidr.includes(":")) {
      if (isIpv6InCidr(trimmed, cidr)) return true;
    } else {
      if (isIpv4InCidr(trimmed, cidr)) return true;
    }
  }
  return false;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const bodyText = await response.text();
    if (!response.ok) {
      // Never include the raw request body (contains no secret here, but the
      // response might echo unexpected vendor-side detail) or auth header in
      // the thrown error — see docs/billing-provider.md#secrets-in-logs.
      throw new Error(`YooKassa request failed: ${response.status} ${response.statusText}`);
    }
    return bodyText ? JSON.parse(bodyText) : {};
  } finally {
    clearTimeout(timeout);
  }
}

type YooKassaPaymentObject = {
  id?: string;
  status?: string;
  paid?: boolean;
  amount?: { value?: string; currency?: string };
  confirmation?: { confirmation_url?: string };
  metadata?: Record<string, string>;
};

/** Only the payment lifecycle this adapter's checkout flow can produce — see this file's own doc comment on why refund.* is out of scope. */
const SUPPORTED_EVENTS = new Set(["payment.succeeded", "payment.waiting_for_capture", "payment.canceled"]);

function statusFromYooKassaPayment(object: YooKassaPaymentObject): BillingSubscriptionStatus {
  switch (object.status) {
    case "succeeded":
      return "active";
    case "waiting_for_capture":
      return "incomplete";
    case "canceled":
      return "canceled";
    default:
      // An unrecognized status inside an otherwise-supported event type —
      // never guess; the caller (verifyAndParseWebhook) already validated
      // the event type, so this genuinely means YooKassa returned a
      // payment status this adapter doesn't know about yet.
      throw new Error(`YooKassa payment status "${object.status}" is not recognized by this adapter`);
  }
}

/**
 * Real adapter for YooKassa (ЮKassa) — a Russian payment processor, chosen
 * per docs/provider-strategy.md's "works from Russia" priority. Verified
 * against YooKassa's own published API documentation
 * (https://yookassa.ru/developers/api,
 * https://yookassa.ru/developers/using-api/webhooks) as of Phase 20 — see
 * docs/billing-provider.md for the specific claims and their sourcing.
 *
 * YooKassa has no native "subscription" object: recurring billing is done
 * by saving a payment method on a first payment and creating later
 * one-off payments against it — a distinct, separate capability this
 * adapter does not implement yet (Phase 20 builds one-time checkout only;
 * see docs/billing-provider.md#recurring-billing-not-yet-implemented).
 * `createCheckout` therefore always creates a single real payment, never
 * a subscription resource.
 */
export function createYooKassaProvider(config: {
  shopId: string;
  secretKey: string;
  allowedCidrs?: readonly string[];
}): BillingProvider {
  const authHeader = `Basic ${Buffer.from(`${config.shopId}:${config.secretKey}`).toString("base64")}`;
  const allowedCidrs = config.allowedCidrs ?? DEFAULT_ALLOWED_CIDRS;

  return {
    name: "yookassa",

    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
      const response = (await fetchJson(`${API_BASE}/payments`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Idempotence-Key": input.idempotencyKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: { value: minorToMajorString(input.amountMinor), currency: input.currency },
          payment_method_data: { type: "bank_card" },
          confirmation: { type: "redirect", return_url: input.returnUrl },
          description: input.description,
          metadata: input.metadata,
          capture: true,
        }),
      })) as YooKassaPaymentObject;

      const externalPaymentId = response.id;
      const checkoutUrl = response.confirmation?.confirmation_url;
      if (!externalPaymentId || !checkoutUrl) {
        throw new Error("YooKassa payment creation response is missing id or confirmation.confirmation_url");
      }
      return { externalPaymentId: externalPaymentId as BillingPaymentId, checkoutUrl };
    },

    verifyAndParseWebhook(rawBody: string, context: WebhookVerificationContext): NormalizedSubscriptionEvent {
      if (!context.sourceIp || !isIpAllowed(context.sourceIp, allowedCidrs)) {
        throw new BillingWebhookVerificationError("yookassa");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        throw new BillingWebhookVerificationError("yookassa");
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as Record<string, unknown>).type !== "notification" ||
        typeof (parsed as Record<string, unknown>).event !== "string" ||
        typeof (parsed as Record<string, unknown>).object !== "object"
      ) {
        throw new BillingWebhookVerificationError("yookassa");
      }
      const event = (parsed as { event: string }).event;
      const object = (parsed as { object: YooKassaPaymentObject }).object;
      if (!SUPPORTED_EVENTS.has(event) || !object.id) {
        throw new BillingWebhookVerificationError("yookassa");
      }

      const status = statusFromYooKassaPayment(object);
      const amountMinor = object.amount?.value !== undefined ? parseAmountInput(object.amount.value) : undefined;

      return {
        // YooKassa's notification payload has no dedicated notification/event
        // id distinct from the payment's own id (confirmed against its
        // documented shape) — `${paymentId}:${event}` is this adapter's own
        // dedup key: stable for a true redelivery of the same event (same
        // payment, same event type), but distinct across genuinely different
        // lifecycle transitions for the same payment (e.g.
        // waiting_for_capture then succeeded), which must both be recorded.
        eventIdentity: { provider: "yookassa", eventId: `${object.id}:${event}` },
        paymentId: object.id as BillingPaymentId,
        status,
        ...(amountMinor !== undefined ? { amountMinor, currency: object.amount?.currency } : {}),
      };
    },
  };
}
