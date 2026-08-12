"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createOrganizationAction } from "./actions";

export function CreateOrganizationForm() {
  const [state, formAction, isPending] = useActionState(createOrganizationAction, null);

  return (
    <form action={formAction} className="mt-2 flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Organization name</Label>
        <Input
          id="name"
          name="name"
          type="text"
          required
          minLength={2}
          maxLength={100}
          placeholder="Acme Manufacturing Ltd"
          aria-invalid={state?.error ? true : undefined}
        />
      </div>

      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}

      <Button type="submit" disabled={isPending} size="lg" className="mt-2">
        {isPending ? "Creating…" : "Enter workspace"}
      </Button>
    </form>
  );
}
