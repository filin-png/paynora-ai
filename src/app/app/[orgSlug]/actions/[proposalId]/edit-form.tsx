"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
    <Card className="p-5">
      <form action={formAction} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="subject">Subject</Label>
          <Input id="subject" name="subject" required maxLength={200} defaultValue={defaultSubject} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="body">Body</Label>
          <Textarea id="body" name="body" required rows={12} defaultValue={defaultBody} />
        </div>
        {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
        <Button type="submit" variant="outline" disabled={isPending} className="self-start">
          {isPending ? "Saving…" : "Save changes"}
        </Button>
      </form>
    </Card>
  );
}
