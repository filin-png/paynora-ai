"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants, type ButtonProps } from "@/components/ui/button";
import { Dialog, DialogCancelButton } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { CommunicationFormState } from "./actions";

type BoundAction = (
  prevState: CommunicationFormState,
  formData: FormData,
) => Promise<CommunicationFormState>;

/**
 * A single explicit-action button. `confirmMessage`, when set, requires
 * the user to confirm in a real dialog before the Server Action fires —
 * used for the two genuinely hard-to-undo sends here: the first manual
 * send of a DRAFT reminder (a real message to a real customer) and
 * "resend after an uncertain outcome," which may send a duplicate (see
 * docs/communications.md#unknown-outcomes and
 * docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md P1/P2). Retrying after a
 * definite FAILED is deliberately left without a second confirmation —
 * it's the same already-decided send, not a new decision, and a dialog on
 * every retry would just be noise.
 */
export function SendCommunicationForm({
  action,
  label,
  pendingLabel,
  confirmMessage,
  confirmTitle = "Are you sure?",
  confirmLabel,
  confirmVariant = "destructive",
  variant = "primary",
}: {
  action: BoundAction;
  label: string;
  pendingLabel: string;
  confirmMessage?: string;
  confirmTitle?: string;
  confirmLabel?: string;
  confirmVariant?: ButtonProps["variant"];
  variant?: ButtonProps["variant"];
}) {
  const [state, formAction, isPending] = useActionState(action, null);

  const form = (
    <form action={formAction}>
      {state?.error ? <Alert tone="danger" className="mb-2">{state.error}</Alert> : null}
      <Button type="submit" disabled={isPending} variant={variant}>
        {isPending ? pendingLabel : label}
      </Button>
    </form>
  );

  if (!confirmMessage) return form;

  return (
    <Dialog
      trigger={
        <button type="button" className={cn(buttonVariants({ variant }))}>
          {label}
        </button>
      }
      title={confirmTitle}
      description={confirmMessage}
    >
      <div className="flex flex-col gap-3">
        {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <DialogCancelButton className={cn(buttonVariants({ variant: "outline", size: "sm" }))} />
          <form action={formAction}>
            <button
              type="submit"
              disabled={isPending}
              className={cn(buttonVariants({ variant: confirmVariant, size: "sm" }))}
            >
              {isPending ? pendingLabel : (confirmLabel ?? label)}
            </button>
          </form>
        </div>
      </div>
    </Dialog>
  );
}
