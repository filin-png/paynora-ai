import { describe, expect, it } from "vitest";

import { InvalidWalletTransactionTransitionError } from "./errors";
import { assertValidWalletTransactionTransition, isValidWalletTransactionTransition } from "./transaction-state-machine";

describe("isValidWalletTransactionTransition", () => {
  it("allows the full happy path: DETECTED -> CONFIRMING -> CONFIRMED", () => {
    expect(isValidWalletTransactionTransition("DETECTED", "CONFIRMING")).toBe(true);
    expect(isValidWalletTransactionTransition("CONFIRMING", "CONFIRMED")).toBe(true);
  });

  it("allows a provider that skips straight to CONFIRMED on first sight", () => {
    expect(isValidWalletTransactionTransition("DETECTED", "CONFIRMED")).toBe(true);
  });

  it("allows a self-loop on DETECTED/CONFIRMING (more confirmations observed, still below threshold)", () => {
    expect(isValidWalletTransactionTransition("DETECTED", "DETECTED")).toBe(true);
    expect(isValidWalletTransactionTransition("CONFIRMING", "CONFIRMING")).toBe(true);
  });

  it("allows failure/expiry from either non-terminal state", () => {
    expect(isValidWalletTransactionTransition("DETECTED", "FAILED")).toBe(true);
    expect(isValidWalletTransactionTransition("DETECTED", "EXPIRED")).toBe(true);
    expect(isValidWalletTransactionTransition("CONFIRMING", "FAILED")).toBe(true);
    expect(isValidWalletTransactionTransition("CONFIRMING", "EXPIRED")).toBe(true);
  });

  it("rejects every transition out of CONFIRMED — terminal", () => {
    expect(isValidWalletTransactionTransition("CONFIRMED", "CONFIRMED")).toBe(false);
    expect(isValidWalletTransactionTransition("CONFIRMED", "CONFIRMING")).toBe(false);
    expect(isValidWalletTransactionTransition("CONFIRMED", "FAILED")).toBe(false);
  });

  it("rejects every transition out of FAILED and EXPIRED — terminal", () => {
    expect(isValidWalletTransactionTransition("FAILED", "CONFIRMED")).toBe(false);
    expect(isValidWalletTransactionTransition("EXPIRED", "CONFIRMED")).toBe(false);
  });

  it("rejects a backward transition from CONFIRMING to DETECTED", () => {
    expect(isValidWalletTransactionTransition("CONFIRMING", "DETECTED")).toBe(false);
  });
});

describe("assertValidWalletTransactionTransition", () => {
  it("throws InvalidWalletTransactionTransitionError for an illegal transition", () => {
    expect(() => assertValidWalletTransactionTransition("CONFIRMED", "DETECTED")).toThrow(
      InvalidWalletTransactionTransitionError,
    );
  });

  it("does not throw for a legal transition", () => {
    expect(() => assertValidWalletTransactionTransition("DETECTED", "CONFIRMING")).not.toThrow();
  });
});
