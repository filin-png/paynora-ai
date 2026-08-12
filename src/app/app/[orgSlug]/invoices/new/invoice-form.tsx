"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SUPPORTED_CURRENCIES } from "@/server/ar/currency";
import { createInvoiceAction, type InvoiceFormState } from "./actions";

type BoundAction = (
  prevState: InvoiceFormState,
  formData: FormData,
) => ReturnType<typeof createInvoiceAction>;

export function InvoiceForm({
  action,
  customers,
  suggestedNumber,
  defaultCustomerId,
  today,
}: {
  action: BoundAction;
  customers: { id: string; name: string }[];
  suggestedNumber: string;
  defaultCustomerId?: string;
  today: string;
}) {
  const [state, formAction, isPending] = useActionState(action, null);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="customerId">Customer</Label>
        <Select id="customerId" name="customerId" required defaultValue={defaultCustomerId ?? ""}>
          <option value="" disabled>
            Select a customer
          </option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="number">Invoice number</Label>
        <Input id="number" name="number" required maxLength={50} defaultValue={suggestedNumber} />
      </div>

      <div className="flex gap-4">
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="currency">Currency</Label>
          <Select id="currency" name="currency" required defaultValue={SUPPORTED_CURRENCIES[0]}>
            {SUPPORTED_CURRENCIES.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="amount">Amount</Label>
          <Input id="amount" name="amount" inputMode="decimal" required placeholder="1000.00" />
        </div>
      </div>

      <div className="flex gap-4">
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="issueDate">Issue date</Label>
          <Input id="issueDate" name="issueDate" type="date" required defaultValue={today} />
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="dueDate">Due date</Label>
          <Input id="dueDate" name="dueDate" type="date" required defaultValue={today} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" rows={3} placeholder="Optional — visible only to your team" />
      </div>

      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}

      <Button type="submit" disabled={isPending} className="mt-2 self-start">
        {isPending ? "Creating…" : "Create invoice"}
      </Button>
    </form>
  );
}
