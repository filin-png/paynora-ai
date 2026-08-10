"use client";

import { useActionState } from "react";

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
    <form action={formAction} className="mt-3 flex max-w-sm items-end gap-3">
      <div className="flex flex-1 flex-col gap-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          name="name"
          type="text"
          defaultValue={currentName}
          required
          minLength={2}
          maxLength={100}
        />
      </div>
      <Button type="submit" variant="outline" disabled={isPending}>
        {isPending ? "Saving…" : "Save"}
      </Button>
      {state?.error ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
