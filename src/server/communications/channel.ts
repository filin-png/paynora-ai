import type { Customer, CommunicationChannel } from "@prisma/client";

/**
 * A customer's real communication destination for a given channel — always
 * a value already present on the tenant-scoped Customer row, never a
 * client-supplied value. See docs/communications.md#channel-model.
 */
export type ResolvedCommunicationDestination = {
  channel: CommunicationChannel;
  /** The recipient identifier for that channel — an email address, or a Telegram chat id. */
  destination: string;
};

export type CommunicationDestinationResult =
  | ({ blocked: false } & ResolvedCommunicationDestination)
  | { blocked: true; reason: string };

/**
 * Which channel — and which destination on that channel — a reminder for
 * this customer should use. Deliberately never guesses between two
 * available destinations: "if email is missing, silently try Telegram" is
 * exactly the hidden-magic behavior this function refuses to do. There are
 * exactly three outcomes:
 *
 * 1. `preferredCommunicationChannel` is explicitly set — use it, or report
 *    BLOCKED if that specific channel's destination isn't actually
 *    configured (e.g. preferred=TELEGRAM but no telegramChatId).
 * 2. Not set, and exactly one destination exists — use it. This is not a
 *    silent choice between options: there is only one candidate, so there
 *    is nothing to choose between. This is what keeps every existing
 *    email-only customer (Phases 1-7) working unchanged.
 * 3. Not set, and either zero or two-or-more destinations exist — BLOCKED.
 *    Zero is "nothing configured yet"; two-or-more is a genuine ambiguity
 *    that must be resolved by a human explicitly setting a preferred
 *    channel, never guessed.
 */
export function resolveCommunicationDestination(
  customer: Pick<Customer, "email" | "telegramChatId" | "preferredCommunicationChannel">,
): CommunicationDestinationResult {
  const hasEmail = Boolean(customer.email);
  const hasTelegram = Boolean(customer.telegramChatId);

  if (customer.preferredCommunicationChannel === "EMAIL") {
    if (!hasEmail) {
      return { blocked: true, reason: "This customer's preferred channel is Email, but no email address is on file." };
    }
    return { blocked: false, channel: "EMAIL", destination: customer.email! };
  }

  if (customer.preferredCommunicationChannel === "TELEGRAM") {
    if (!hasTelegram) {
      return {
        blocked: true,
        reason: "This customer's preferred channel is Telegram, but no Telegram destination is on file.",
      };
    }
    return { blocked: false, channel: "TELEGRAM", destination: customer.telegramChatId! };
  }

  if (hasEmail && hasTelegram) {
    return {
      blocked: true,
      reason:
        "This customer has both an email address and a Telegram destination configured — set a preferred channel to remove the ambiguity.",
    };
  }
  if (hasEmail) {
    return { blocked: false, channel: "EMAIL", destination: customer.email! };
  }
  if (hasTelegram) {
    return { blocked: false, channel: "TELEGRAM", destination: customer.telegramChatId! };
  }
  return { blocked: true, reason: "This customer has no communication destination on file (no email or Telegram)." };
}
