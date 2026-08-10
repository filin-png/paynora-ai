"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { recordPaymentAction, type PaymentFormState } from "./actions";

type BoundAction = (
  prevState: PaymentFormState,
  formData: FormData,
) => ReturnType<typeof recordPaymentAction>;

export function RecordPaymentForm({ action, today }: { action: BoundAction; today: string }) {
  const [state, formAction, isPending] = useActionState(action, null);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex gap-4">
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="amount">Amount</Label>
          <Input id="amount" name="amount" inputMode="decimal" required placeholder="0.00" />
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="paidAt">Date received</Label>
          <Input id="paidAt" name="paidAt" type="date" required defaultValue={today} />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="note">Note</Label>
        <Input id="note" name="note" maxLength={500} />
      </div>

      {state?.error ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" disabled={isPending} className="self-start">
        {isPending ? "Recording…" : "Record payment"}
      </Button>
    </form>
  );
}
