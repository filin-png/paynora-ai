"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type CustomerFormState = { error: string } | null;
type CustomerFormAction = (
  prevState: CustomerFormState,
  formData: FormData,
) => Promise<CustomerFormState>;

export function CustomerForm({
  action,
  defaultValues,
  submitLabel = "Save",
}: {
  action: CustomerFormAction;
  defaultValues?: {
    name?: string;
    email?: string | null;
    phone?: string | null;
    companyName?: string | null;
    notes?: string | null;
  };
  submitLabel?: string;
}) {
  const [state, formAction, isPending] = useActionState(action, null);

  return (
    <form action={formAction} className="flex max-w-lg flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" required maxLength={200} defaultValue={defaultValues?.name} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          defaultValue={defaultValues?.email ?? undefined}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="phone">Phone</Label>
        <Input id="phone" name="phone" defaultValue={defaultValues?.phone ?? undefined} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="companyName">Company</Label>
        <Input
          id="companyName"
          name="companyName"
          defaultValue={defaultValues?.companyName ?? undefined}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="notes">Notes</Label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          defaultValue={defaultValues?.notes ?? undefined}
          className="flex w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
      </div>

      {state?.error ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" disabled={isPending} className="mt-2 self-start">
        {isPending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
