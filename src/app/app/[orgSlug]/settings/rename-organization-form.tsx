"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { renameOrganizationAction } from "./actions";

export function RenameOrganizationForm({
  orgSlug,
  currentName,
}: {
  orgSlug: string;
  currentName: string;
}) {
  const boundAction = renameOrganizationAction.bind(null, orgSlug);
  const [state, formAction, isPending] = useActionState(boundAction, null);

  return (
    <form action={formAction} className="mt-4 flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          name="name"
          type="text"
          defaultValue={currentName}
          required
          minLength={2}
          maxLength={100}
          aria-invalid={state?.error ? true : undefined}
        />
      </div>
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <Button type="submit" variant="outline" disabled={isPending} className="self-start">
        {isPending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
