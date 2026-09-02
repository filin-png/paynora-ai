import type { InsightPriority } from "@prisma/client";

/**
 * Phase 16 notification *policy* — deliberately architecture only. This
 * module decides whether a signal is worth surfacing proactively; it does
 * not send anything. No code path in this codebase calls a
 * MessagingProvider/EmailProvider based on this decision yet — wiring
 * actual delivery (with its own throttling, per-organization/per-user
 * opt-in, and the same approval-respecting rules every other outbound
 * message in this codebase already follows) is explicitly out of scope
 * for this phase. See docs/proactive-financial-operations.md#notifications.
 *
 * The policy itself is real and testable: given a signal, it returns a
 * decision and a human-readable reason — never a mystery boolean.
 */
export type NotifiableSignal =
  | { kind: "invoice_risk_escalated"; bucket: "MEDIUM" | "HIGH" }
  | { kind: "cash_flow_risk_window"; isPotentialRisk: boolean }
  | { kind: "payment_received" }
  | { kind: "action_requires_approval"; priority: InsightPriority };

export type NotificationDecision = { shouldNotify: boolean; reason: string };

export function shouldNotify(signal: NotifiableSignal): NotificationDecision {
  switch (signal.kind) {
    case "invoice_risk_escalated":
      return signal.bucket === "HIGH"
        ? { shouldNotify: true, reason: "Invoice escalated to high risk" }
        : { shouldNotify: false, reason: "MEDIUM-risk escalations are common; only HIGH is notification-worthy" };
    case "cash_flow_risk_window":
      return signal.isPotentialRisk
        ? { shouldNotify: true, reason: "A cash-flow risk window was newly identified" }
        : { shouldNotify: false, reason: "No meaningful cash-flow risk in this window" };
    case "payment_received":
      return { shouldNotify: false, reason: "Good news is visible in the product; not worth interrupting for" };
    case "action_requires_approval":
      return signal.priority === "HIGH"
        ? { shouldNotify: true, reason: "A high-priority action is awaiting approval" }
        : { shouldNotify: false, reason: "Only HIGH-priority pending actions are notification-worthy" };
  }
}
