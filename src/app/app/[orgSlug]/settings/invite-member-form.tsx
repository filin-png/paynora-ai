"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { inviteMemberAction } from "./invitation-actions";

export function InviteMemberForm({ orgSlug }: { orgSlug: string }) {
  const boundAction = inviteMemberAction.bind(null, orgSlug);
  const [state, formAction, isPending] = useActionState(boundAction, null);

  return (
    <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex flex-1 flex-col gap-2">
        <Label htmlFor="invite-email">Invite by email</Label>
        <Input id="invite-email" name="email" type="email" placeholder="teammate@company.com" required />
      </div>
      <div className="flex flex-col gap-2 sm:w-36">
        <Label htmlFor="invite-role">Role</Label>
        <Select id="invite-role" name="role" defaultValue="MEMBER">
          <option value="MEMBER">Member</option>
          <option value="OWNER">Owner</option>
        </Select>
      </div>
      <Button type="submit" disabled={isPending} className="sm:self-end">
        {isPending ? "Sending…" : "Send invite"}
      </Button>

      {state && "error" in state ? (
        <Alert tone="danger" className="basis-full">
          {state.error}
        </Alert>
      ) : null}
      {state && "success" in state ? (
        <Alert tone="success" className="basis-full">
          Invitation sent.
        </Alert>
      ) : null}
    </form>
  );
}
