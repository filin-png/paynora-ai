"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { Alert } from "@/components/ui/alert";
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

  // Phase 9 payment idempotency (docs/audits/PAYNORA-AUDIT-V1-REMEDIATION.md
  // P1-1): one key per logical submission. A failed submission (network
  // error, timeout, a retried click) resubmits the SAME key, so the server
  // recognizes it as a retry rather than a second real payment. A
  // *successful* submission gets a fresh key for whatever the user enters
  // next — reusing a stale key there would make recordPayment think a new,
  // intentional payment is a duplicate of the one that already succeeded.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !isPending && state === null) {
      // Just transitioned from submitting to done, with no error — a
      // successful record. (The same `state === null` shape as the
      // initial pre-submission state, distinguished by the pending edge.)
      setIdempotencyKey(crypto.randomUUID());
    }
    wasPending.current = isPending;
  }, [isPending, state]);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
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
        <Input id="note" name="note" maxLength={500} placeholder="Optional" />
      </div>

      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}

      <Button type="submit" disabled={isPending} className="self-start">
        {isPending ? "Recording…" : "Record payment"}
      </Button>
    </form>
  );
}
