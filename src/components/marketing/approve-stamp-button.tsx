"use client";

import * as React from "react";
import { CheckCheck } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The felt half of "The Pulse" motif (see docs/product-ui.md#design-system):
 * approving a proposal gets a real, momentary confirmation instead of
 * silently updating a badge — tied directly to the product's actual
 * promise (a human deliberately approves; PAYNORA never sends on its own).
 * Landing-page marketing mockup only — no server call, matches the rest of
 * feature-mockups.tsx's "illustrative, not live data" pattern.
 */
export function ApproveStampButton({ size = "sm" }: { size?: "xs" | "sm" }) {
  const [approved, setApproved] = React.useState(false);
  const stampSize = size === "xs" ? "size-7" : "size-9";
  const iconSize = size === "xs" ? "size-3" : "size-4";

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        disabled={approved}
        onClick={() => setApproved(true)}
        className={cn(
          "inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-opacity",
          size === "xs" ? "text-[10px]" : "text-[11px]",
          approved ? "bg-success/20 text-success opacity-70" : "bg-primary text-primary-foreground hover:bg-primary-hover",
        )}
      >
        <CheckCheck className="size-3" />
        {approved ? "Approved" : "Approve"}
      </button>
      {approved ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute -top-3 -right-3 flex items-center justify-center rounded-full border-2 border-success text-success motion-safe:animate-[paynora-stamp-in_.55s_cubic-bezier(.2,1.6,.4,1)_forwards]",
            stampSize,
          )}
          style={{
            background: "rgb(5 7 13 / 0.65)",
            boxShadow: "0 0 0 5px rgb(52 211 153 / 0.1), 0 0 22px rgb(52 211 153 / 0.35)",
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" className={iconSize}>
            <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      ) : null}
    </span>
  );
}
