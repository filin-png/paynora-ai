import { describe, expect, it } from "vitest";

import { resolveCommunicationDestination } from "./channel";

describe("resolveCommunicationDestination", () => {
  it("auto-selects EMAIL when it's the only destination configured", () => {
    const result = resolveCommunicationDestination({
      email: "customer@example.com",
      telegramChatId: null,
      preferredCommunicationChannel: null,
    });
    expect(result).toEqual({ blocked: false, channel: "EMAIL", destination: "customer@example.com" });
  });

  it("auto-selects TELEGRAM when it's the only destination configured", () => {
    const result = resolveCommunicationDestination({
      email: null,
      telegramChatId: "123456789",
      preferredCommunicationChannel: null,
    });
    expect(result).toEqual({ blocked: false, channel: "TELEGRAM", destination: "123456789" });
  });

  it("is blocked, never silently picks one, when both are configured and no preference is set", () => {
    const result = resolveCommunicationDestination({
      email: "customer@example.com",
      telegramChatId: "123456789",
      preferredCommunicationChannel: null,
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.reason).toMatch(/ambiguity|preferred channel/i);
  });

  it("is blocked when neither destination is configured", () => {
    const result = resolveCommunicationDestination({
      email: null,
      telegramChatId: null,
      preferredCommunicationChannel: null,
    });
    expect(result).toEqual({ blocked: true, reason: expect.stringContaining("no communication destination") });
  });

  it("respects an explicit EMAIL preference even when Telegram is also configured", () => {
    const result = resolveCommunicationDestination({
      email: "customer@example.com",
      telegramChatId: "123456789",
      preferredCommunicationChannel: "EMAIL",
    });
    expect(result).toEqual({ blocked: false, channel: "EMAIL", destination: "customer@example.com" });
  });

  it("respects an explicit TELEGRAM preference even when email is also configured", () => {
    const result = resolveCommunicationDestination({
      email: "customer@example.com",
      telegramChatId: "123456789",
      preferredCommunicationChannel: "TELEGRAM",
    });
    expect(result).toEqual({ blocked: false, channel: "TELEGRAM", destination: "123456789" });
  });

  it("is blocked when the preferred channel's own destination is missing (EMAIL preferred, no email)", () => {
    const result = resolveCommunicationDestination({
      email: null,
      telegramChatId: "123456789",
      preferredCommunicationChannel: "EMAIL",
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.reason).toMatch(/preferred channel is Email/i);
  });

  it("is blocked when the preferred channel's own destination is missing (TELEGRAM preferred, no chat id)", () => {
    const result = resolveCommunicationDestination({
      email: "customer@example.com",
      telegramChatId: null,
      preferredCommunicationChannel: "TELEGRAM",
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.reason).toMatch(/preferred channel is Telegram/i);
  });
});
