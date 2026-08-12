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
 * used only for "resend after an uncertain outcome," which may send a
 * duplicate email (see docs/communications.md#unknown-outcomes). Every
 * other send/retry here is already safe to click without a second
 * confirmation — the safety comes from sendCommunication's own atomic
 * claim, not from the UI.
 */
export function SendCommunicationForm({
  action,
  label,
  pendingLabel,
  confirmMessage,
  variant = "primary",
}: {
  action: BoundAction;
  label: string;
  pendingLabel: string;
  confirmMessage?: string;
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
      title="Resend this email?"
      description={confirmMessage}
    >
      <div className="flex flex-col gap-3">
        {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <DialogCancelButton className={cn(buttonVariants({ variant: "outline", size: "sm" }))} />
          <form action={formAction}>
            <button type="submit" disabled={isPending} className={cn(buttonVariants({ variant: "destructive", size: "sm" }))}>
              {isPending ? pendingLabel : "Resend"}
            </button>
          </form>
        </div>
      </div>
    </Dialog>
  );
}
