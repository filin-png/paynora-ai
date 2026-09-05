import { afterEach, describe, expect, it, vi } from "vitest";

import { BillingWebhookVerificationError } from "../errors";
import { createYooKassaProvider, DEFAULT_ALLOWED_CIDRS, isIpAllowed } from "./yookassa";

describe("isIpAllowed — real CIDR matching (IPv4 and IPv6)", () => {
  it("matches an IPv4 address inside a documented /27 range", () => {
    expect(isIpAllowed("185.71.76.5", DEFAULT_ALLOWED_CIDRS)).toBe(true);
    expect(isIpAllowed("185.71.76.31", DEFAULT_ALLOWED_CIDRS)).toBe(true);
  });

  it("rejects an IPv4 address just outside a documented /27 range", () => {
    expect(isIpAllowed("185.71.76.32", DEFAULT_ALLOWED_CIDRS)).toBe(false);
    expect(isIpAllowed("185.71.76.63", DEFAULT_ALLOWED_CIDRS)).toBe(false);
  });

  it("matches an IPv4 /32 single-host entry only exactly", () => {
    expect(isIpAllowed("77.75.156.11", DEFAULT_ALLOWED_CIDRS)).toBe(true);
    expect(isIpAllowed("77.75.156.12", DEFAULT_ALLOWED_CIDRS)).toBe(false);
  });

  it("matches an IPv4 address inside the documented /25 range", () => {
    expect(isIpAllowed("77.75.153.1", DEFAULT_ALLOWED_CIDRS)).toBe(true);
    expect(isIpAllowed("77.75.153.127", DEFAULT_ALLOWED_CIDRS)).toBe(true);
    expect(isIpAllowed("77.75.153.128", DEFAULT_ALLOWED_CIDRS)).toBe(false);
  });

  it("rejects a completely unrelated IPv4 address (e.g. a spoofed origin)", () => {
    expect(isIpAllowed("8.8.8.8", DEFAULT_ALLOWED_CIDRS)).toBe(false);
    expect(isIpAllowed("1.1.1.1", DEFAULT_ALLOWED_CIDRS)).toBe(false);
  });

  it("matches an IPv6 address inside the documented /32 range", () => {
    expect(isIpAllowed("2a02:5180::1", DEFAULT_ALLOWED_CIDRS)).toBe(true);
    expect(isIpAllowed("2a02:5180:ffff:ffff:ffff:ffff:ffff:ffff", DEFAULT_ALLOWED_CIDRS)).toBe(true);
  });

  it("rejects an IPv6 address outside the documented /32 range", () => {
    expect(isIpAllowed("2a02:5181::1", DEFAULT_ALLOWED_CIDRS)).toBe(false);
    expect(isIpAllowed("::1", DEFAULT_ALLOWED_CIDRS)).toBe(false);
  });

  it("rejects malformed input rather than throwing", () => {
    expect(isIpAllowed("not-an-ip", DEFAULT_ALLOWED_CIDRS)).toBe(false);
    expect(isIpAllowed("999.999.999.999", DEFAULT_ALLOWED_CIDRS)).toBe(false);
    expect(isIpAllowed("", DEFAULT_ALLOWED_CIDRS)).toBe(false);
  });
});

const CONFIG = { shopId: "shop_test", secretKey: "secret_test" };
const ALLOWED_IP = "185.71.76.5";

describe("createYooKassaProvider — createCheckout (real request shape, mocked network)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to the real YooKassa payments endpoint with Basic auth, Idempotence-Key, and the exact amount/return_url/metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          id: "2b1b7d4e-000f-5000-8000-1234567890ab",
          status: "pending",
          confirmation: { confirmation_url: "https://yookassa.ru/checkout/pay?x=1" },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createYooKassaProvider(CONFIG);
    const result = await provider.createCheckout({
      amountMinor: 199000n,
      currency: "RUB",
      description: "PAYNORA STARTER plan subscription",
      returnUrl: "https://app.paynora.test/app/acme/settings?tab=billing",
      idempotencyKey: "idem-key-1",
      metadata: { organizationId: "org_1", targetPlanId: "STARTER" },
    });

    expect(result).toEqual({
      externalPaymentId: "2b1b7d4e-000f-5000-8000-1234567890ab",
      checkoutUrl: "https://yookassa.ru/checkout/pay?x=1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.yookassa.ru/v3/payments");
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotence-Key"]).toBe("idem-key-1");
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("shop_test:secret_test").toString("base64")}`);

    const body = JSON.parse(init.body as string);
    expect(body.amount).toEqual({ value: "1990.00", currency: "RUB" });
    expect(body.confirmation).toEqual({
      type: "redirect",
      return_url: "https://app.paynora.test/app/acme/settings?tab=billing",
    });
    expect(body.metadata).toEqual({ organizationId: "org_1", targetPlanId: "STARTER" });
  });

  it("throws when the vendor response is missing id or confirmation_url — never fabricates a checkout URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ status: "pending" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createYooKassaProvider(CONFIG);
    await expect(
      provider.createCheckout({
        amountMinor: 199000n,
        currency: "RUB",
        description: "x",
        returnUrl: "https://app.paynora.test/x",
        idempotencyKey: "idem-key-2",
        metadata: {},
      }),
    ).rejects.toThrow(/missing id or confirmation/);
  });

  it("throws (without leaking response body) when the vendor returns a non-2xx status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => JSON.stringify({ type: "error", description: "secret leaked in a real scenario" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createYooKassaProvider(CONFIG);
    await expect(
      provider.createCheckout({
        amountMinor: 100n,
        currency: "RUB",
        description: "x",
        returnUrl: "https://app.paynora.test/x",
        idempotencyKey: "idem-key-3",
        metadata: {},
      }),
    ).rejects.toThrow("YooKassa request failed: 401 Unauthorized");
  });
});

describe("createYooKassaProvider — verifyAndParseWebhook (source-IP allowlist + real notification shape)", () => {
  function notification(event: string, object: Record<string, unknown>): string {
    return JSON.stringify({ type: "notification", event, object });
  }

  it("rejects a webhook with no sourceIp at all", () => {
    const provider = createYooKassaProvider(CONFIG);
    expect(() =>
      provider.verifyAndParseWebhook(notification("payment.succeeded", { id: "pay_1", status: "succeeded" }), {}),
    ).toThrow(BillingWebhookVerificationError);
  });

  it("rejects a webhook from a source IP outside the allowlist (forged/unauthenticated delivery)", () => {
    const provider = createYooKassaProvider(CONFIG);
    expect(() =>
      provider.verifyAndParseWebhook(notification("payment.succeeded", { id: "pay_1", status: "succeeded" }), {
        sourceIp: "8.8.8.8",
      }),
    ).toThrow(BillingWebhookVerificationError);
  });

  it("rejects malformed JSON", () => {
    const provider = createYooKassaProvider(CONFIG);
    expect(() => provider.verifyAndParseWebhook("not json", { sourceIp: ALLOWED_IP })).toThrow(
      BillingWebhookVerificationError,
    );
  });

  it("rejects a payload that isn't a real YooKassa notification shape", () => {
    const provider = createYooKassaProvider(CONFIG);
    expect(() =>
      provider.verifyAndParseWebhook(JSON.stringify({ hello: "world" }), { sourceIp: ALLOWED_IP }),
    ).toThrow(BillingWebhookVerificationError);
  });

  it("rejects an event type this adapter's checkout flow never produces", () => {
    const provider = createYooKassaProvider(CONFIG);
    expect(() =>
      provider.verifyAndParseWebhook(notification("refund.succeeded", { id: "ref_1", status: "succeeded" }), {
        sourceIp: ALLOWED_IP,
      }),
    ).toThrow(BillingWebhookVerificationError);
  });

  it("rejects a notification object missing its own id", () => {
    const provider = createYooKassaProvider(CONFIG);
    expect(() =>
      provider.verifyAndParseWebhook(notification("payment.succeeded", { status: "succeeded" }), {
        sourceIp: ALLOWED_IP,
      }),
    ).toThrow(BillingWebhookVerificationError);
  });

  it("parses a real payment.succeeded notification into 'active' with the composite eventId and amount", () => {
    const provider = createYooKassaProvider(CONFIG);
    const result = provider.verifyAndParseWebhook(
      notification("payment.succeeded", {
        id: "pay_abc123",
        status: "succeeded",
        paid: true,
        amount: { value: "1990.00", currency: "RUB" },
      }),
      { sourceIp: ALLOWED_IP },
    );

    expect(result).toEqual({
      eventIdentity: { provider: "yookassa", eventId: "pay_abc123:payment.succeeded" },
      paymentId: "pay_abc123",
      status: "active",
      amountMinor: 199000n,
      currency: "RUB",
    });
  });

  it("parses payment.waiting_for_capture as 'incomplete'", () => {
    const provider = createYooKassaProvider(CONFIG);
    const result = provider.verifyAndParseWebhook(
      notification("payment.waiting_for_capture", { id: "pay_wfc", status: "waiting_for_capture" }),
      { sourceIp: ALLOWED_IP },
    );
    expect(result.status).toBe("incomplete");
    expect(result.eventIdentity.eventId).toBe("pay_wfc:payment.waiting_for_capture");
  });

  it("parses payment.canceled as 'canceled'", () => {
    const provider = createYooKassaProvider(CONFIG);
    const result = provider.verifyAndParseWebhook(
      notification("payment.canceled", { id: "pay_can", status: "canceled" }),
      { sourceIp: ALLOWED_IP },
    );
    expect(result.status).toBe("canceled");
  });

  it("an event with no amount field omits amountMinor/currency rather than fabricating them", () => {
    const provider = createYooKassaProvider(CONFIG);
    const result = provider.verifyAndParseWebhook(
      notification("payment.canceled", { id: "pay_no_amount", status: "canceled" }),
      { sourceIp: ALLOWED_IP },
    );
    expect(result.amountMinor).toBeUndefined();
    expect(result.currency).toBeUndefined();
  });

  it("accepts a caller-supplied allowedCidrs override (e.g. YUKASSA_WEBHOOK_IP_ALLOWLIST)", () => {
    const provider = createYooKassaProvider({ ...CONFIG, allowedCidrs: ["203.0.113.0/24"] });
    expect(() =>
      provider.verifyAndParseWebhook(notification("payment.succeeded", { id: "pay_1", status: "succeeded" }), {
        sourceIp: ALLOWED_IP, // no longer allowed once the default list is overridden
      }),
    ).toThrow(BillingWebhookVerificationError);

    const result = provider.verifyAndParseWebhook(
      notification("payment.succeeded", { id: "pay_1", status: "succeeded" }),
      { sourceIp: "203.0.113.42" },
    );
    expect(result.status).toBe("active");
  });
});
