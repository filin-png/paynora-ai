import { describe, expect, it } from "vitest";

import { shouldNotify } from "./policy";

describe("shouldNotify", () => {
  it("notifies for a HIGH-bucket risk escalation but not MEDIUM", () => {
    expect(shouldNotify({ kind: "invoice_risk_escalated", bucket: "HIGH" }).shouldNotify).toBe(true);
    expect(shouldNotify({ kind: "invoice_risk_escalated", bucket: "MEDIUM" }).shouldNotify).toBe(false);
  });

  it("notifies for a real cash-flow risk window but not a non-risky one", () => {
    expect(shouldNotify({ kind: "cash_flow_risk_window", isPotentialRisk: true }).shouldNotify).toBe(true);
    expect(shouldNotify({ kind: "cash_flow_risk_window", isPotentialRisk: false }).shouldNotify).toBe(false);
  });

  it("never notifies for a payment received — good news is not interruption-worthy", () => {
    expect(shouldNotify({ kind: "payment_received" }).shouldNotify).toBe(false);
  });

  it("notifies for a HIGH-priority pending action but not MEDIUM or LOW", () => {
    expect(shouldNotify({ kind: "action_requires_approval", priority: "HIGH" }).shouldNotify).toBe(true);
    expect(shouldNotify({ kind: "action_requires_approval", priority: "MEDIUM" }).shouldNotify).toBe(false);
    expect(shouldNotify({ kind: "action_requires_approval", priority: "LOW" }).shouldNotify).toBe(false);
  });

  it("always returns a human-readable reason, never an empty string", () => {
    const decision = shouldNotify({ kind: "payment_received" });
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});
