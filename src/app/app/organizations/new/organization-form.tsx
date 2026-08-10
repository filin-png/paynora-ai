"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createOrganizationAction } from "./actions";

export function CreateOrganizationForm() {
  const [state, formAction, isPending] = useActionState(createOrganizationAction, null);

  return (
    <form action={formAction} className="mt-8 flex max-w-sm flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Organization name</Label>
        <Input id="name" name="name" type="text" required minLength={2} maxLength={100} />
      </div>

      {state?.error ? (
        <p className="text-sm text-red-600" role="alert">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" disabled={isPending} className="mt-2 self-start">
        {isPending ? "Creating…" : "Create organization"}
      </Button>
    </form>
  );
}
