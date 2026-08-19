"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { isEntitlementLimitMessage, UpgradePlanLink } from "@/components/billing/upgrade-hint";

export type CustomerFormState = { error: string } | null;
type CustomerFormAction = (
  prevState: CustomerFormState,
  formData: FormData,
) => Promise<CustomerFormState>;

export function CustomerForm({
  action,
  orgSlug,
  defaultValues,
  submitLabel = "Save",
}: {
  action: CustomerFormAction;
  /** Only needed to build the "View plans" link shown on a plan-limit error — omit when this form can't hit a creation limit (e.g. editing). */
  orgSlug?: string;
  defaultValues?: {
    name?: string;
    email?: string | null;
    phone?: string | null;
    companyName?: string | null;
    notes?: string | null;
    telegramChatId?: string | null;
    preferredCommunicationChannel?: "EMAIL" | "TELEGRAM" | null;
  };
  submitLabel?: string;
}) {
  const [state, formAction, isPending] = useActionState(action, null);

  return (
    <form action={formAction} className="flex flex-col gap-4">
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
        <Textarea id="notes" name="notes" rows={3} defaultValue={defaultValues?.notes ?? undefined} />
      </div>

      <div className="flex flex-col gap-4 rounded-md border border-border-strong p-4">
        <p className="text-xs font-medium text-muted-foreground">Communication channel</p>
        <div className="flex flex-col gap-2">
          <Label htmlFor="telegramChatId">Telegram chat id</Label>
          <Input
            id="telegramChatId"
            name="telegramChatId"
            placeholder="e.g. 123456789 or @channelname"
            defaultValue={defaultValues?.telegramChatId ?? undefined}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="preferredCommunicationChannel">Preferred channel</Label>
          <Select
            id="preferredCommunicationChannel"
            name="preferredCommunicationChannel"
            defaultValue={defaultValues?.preferredCommunicationChannel ?? ""}
          >
            <option value="">Not set — use the only destination configured</option>
            <option value="EMAIL">Email</option>
            <option value="TELEGRAM">Telegram</option>
          </Select>
          <p className="text-xs text-muted">
            Only required if both email and a Telegram destination are configured — otherwise PAYNORA uses
            whichever one is set.
          </p>
        </div>
      </div>

      {state?.error ? (
        <Alert tone="danger">
          <div className="flex flex-col items-start gap-1.5">
            <span>{state.error}</span>
            {orgSlug && isEntitlementLimitMessage(state.error) ? <UpgradePlanLink orgSlug={orgSlug} /> : null}
          </div>
        </Alert>
      ) : null}

      <Button type="submit" disabled={isPending} className="mt-2 self-start">
        {isPending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
