"use client";

import { useActionState } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import type { CommunicationFormState } from "./actions";

type BoundAction = (
  prevState: CommunicationFormState,
  formData: FormData,
) => Promise<CommunicationFormState>;

/**
 * A single explicit-action button. `confirmMessage`, when set, requires
 * the user to confirm in a native browser dialog before the Server Action
 * fires — used only for "resend after an uncertain outcome," which may
 * send a duplicate email (see docs/communications.md#unknown-outcomes).
 * Every other send/retry here is already safe to click without a second
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

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (confirmMessage && !window.confirm(confirmMessage)) {
          event.preventDefault();
        }
      }}
    >
      {state?.error ? (
        <p className="mb-2 text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={isPending} variant={variant}>
        {isPending ? pendingLabel : label}
      </Button>
    </form>
  );
}
