"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Dictionary } from "@/lib/i18n";
import type { CommunicationFormState } from "./actions";

type BoundAction = (
  prevState: CommunicationFormState,
  formData: FormData,
) => Promise<CommunicationFormState>;

export function EditCommunicationForm({
  action,
  defaultSubject,
  defaultBody,
  dict,
}: {
  action: BoundAction;
  defaultSubject: string;
  defaultBody: string;
  dict: Dictionary;
}) {
  const [state, formAction, isPending] = useActionState(action, null);
  const t = dict.actionDetail;

  return (
    <Card className="p-5">
      <form action={formAction} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="subject">{t.subjectLabel}</Label>
          <Input id="subject" name="subject" required maxLength={200} defaultValue={defaultSubject} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="body">{t.bodyLabel}</Label>
          <Textarea id="body" name="body" required rows={12} defaultValue={defaultBody} />
        </div>
        {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
        <Button type="submit" variant="outline" disabled={isPending} className="self-start">
          {isPending ? t.savingEllipsis : t.saveChanges}
        </Button>
      </form>
    </Card>
  );
}
