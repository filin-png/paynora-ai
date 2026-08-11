"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CommunicationFormState } from "./actions";

type BoundAction = (
  prevState: CommunicationFormState,
  formData: FormData,
) => Promise<CommunicationFormState>;

export function EditCommunicationForm({
  action,
  defaultSubject,
  defaultBody,
}: {
  action: BoundAction;
  defaultSubject: string;
  defaultBody: string;
}) {
  const [state, formAction, isPending] = useActionState(action, null);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="subject">Subject</Label>
        <Input id="subject" name="subject" required maxLength={200} defaultValue={defaultSubject} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="body">Body</Label>
        <textarea
          id="body"
          name="body"
          required
          rows={12}
          defaultValue={defaultBody}
          className="flex w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
      </div>
      {state?.error ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={isPending} className="self-start">
        {isPending ? "Saving…" : "Save changes"}
      </Button>
    </form>
  );
}
