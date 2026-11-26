"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants, type ButtonProps } from "@/components/ui/button";
import { Dialog, DialogCancelButton } from "@/components/ui/dialog";
import type { Dictionary } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { CommunicationFormState } from "./actions";

type BoundAction = (
  prevState: CommunicationFormState,
  formData: FormData,
) => Promise<CommunicationFormState>;

/** Optional confirmation dialog for an initial manual dispatch. */
export function SendCommunicationForm({
  action,
  label,
  pendingLabel,
  confirmMessage,
  confirmTitle,
  confirmLabel,
  confirmVariant = "destructive",
  variant = "primary",
  dict,
}: {
  action: BoundAction;
  label: string;
  pendingLabel: string;
  confirmMessage?: string;
  confirmTitle?: string;
  confirmLabel?: string;
  confirmVariant?: ButtonProps["variant"];
  variant?: ButtonProps["variant"];
  dict?: Dictionary;
}) {
  const resolvedConfirmTitle = confirmTitle ?? dict?.actionDetail.areYouSure ?? "Are you sure?";
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
      title={resolvedConfirmTitle}
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
