"use client";

import type { ReactNode } from "react";

import { buttonVariants, type ButtonProps } from "@/components/ui/button";
import { Dialog, DialogCancelButton } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Wraps any trigger element in a confirmation Dialog before a consequential
 * Server Action fires — see docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md
 * P1/P2 (high-risk confirmation UX: enabling AUTO_SEND, enabling the
 * organization automation kill-switch). Reuses the same accessible, native
 * `<dialog>`-based Dialog already used for "resend after an uncertain
 * outcome" (src/app/app/[orgSlug]/actions/[proposalId]/send-form.tsx)
 * rather than introducing a second confirmation mechanism — one dialog
 * pattern, applied only to the handful of actions that are genuinely hard
 * to undo, not every button on the page.
 */
export function ConfirmActionButton({
  trigger,
  action,
  confirmTitle,
  confirmDescription,
  confirmLabel = "Confirm",
  confirmVariant = "destructive",
}: {
  trigger: ReactNode;
  action: () => Promise<void>;
  confirmTitle: string;
  confirmDescription: string;
  confirmLabel?: string;
  confirmVariant?: ButtonProps["variant"];
}) {
  return (
    <Dialog trigger={trigger} title={confirmTitle} description={confirmDescription}>
      <div className="flex justify-end gap-2">
        <DialogCancelButton className={cn(buttonVariants({ variant: "outline", size: "sm" }))} />
        <form action={action}>
          <button type="submit" className={cn(buttonVariants({ variant: confirmVariant, size: "sm" }))}>
            {confirmLabel}
          </button>
        </form>
      </div>
    </Dialog>
  );
}
