import { BillingDisabledError } from "../errors";
import type { BillingProvider, NormalizedSubscriptionEvent } from "../types";

/**
 * The default provider when BILLING_PROVIDER=none (src/lib/env.ts) —
 * mirrors src/server/email/providers/none.ts and
 * src/server/messaging/providers/none.ts.
 */
export const noneBillingProvider: BillingProvider = {
  name: "none",
  async createCheckout() {
    throw new BillingDisabledError();
  },
  verifyAndParseWebhook(): NormalizedSubscriptionEvent {
    throw new BillingDisabledError();
  },
};
