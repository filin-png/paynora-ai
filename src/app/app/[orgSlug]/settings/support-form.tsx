"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { submitSupportRequestAction } from "./support-actions";

export function SupportForm({ orgSlug }: { orgSlug: string }) {
  const boundAction = submitSupportRequestAction.bind(null, orgSlug);
  const [state, formAction, isPending] = useActionState(boundAction, null);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Label htmlFor="support-message">Your message</Label>
        <Textarea
          id="support-message"
          name="message"
          placeholder="What can we help with?"
          rows={4}
          maxLength={4000}
          required
        />
      </div>
      <Button type="submit" disabled={isPending} className="self-start" size="sm">
        {isPending ? "Sending…" : "Send message"}
      </Button>

      {state && "error" in state ? <Alert tone="danger">{state.error}</Alert> : null}
      {state && "success" in state ? <Alert tone="success">Sent — thanks, we&rsquo;ll get back to you.</Alert> : null}
    </form>
  );
}
