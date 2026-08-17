"use client";

import { useActionState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { OrganizationRole } from "@prisma/client";
import { revokeInvitationAction } from "./invitation-actions";

export type PendingInvitationSummary = {
  id: string;
  email: string;
  role: OrganizationRole;
  expiresAt: string;
};

export function PendingInvitationsList({
  orgSlug,
  invitations,
}: {
  orgSlug: string;
  invitations: PendingInvitationSummary[];
}) {
  if (invitations.length === 0) return null;

  return (
    <div className="mt-4">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Pending invitations</p>
      <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
        {invitations.map((invitation) => (
          <PendingInvitationRow key={invitation.id} orgSlug={orgSlug} invitation={invitation} />
        ))}
      </ul>
    </div>
  );
}

function PendingInvitationRow({
  orgSlug,
  invitation,
}: {
  orgSlug: string;
  invitation: PendingInvitationSummary;
}) {
  const boundAction = revokeInvitationAction.bind(null, orgSlug, invitation.id);
  const [state, formAction, isPending] = useActionState(boundAction, null);

  return (
    <li className="flex flex-col gap-2 px-5 py-3.5 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2">
        <span className="text-foreground">{invitation.email}</span>
        <Badge tone={invitation.role === "OWNER" ? "info" : "neutral"}>
          {invitation.role === "OWNER" ? "Owner" : "Member"}
        </Badge>
      </div>
      <div className="flex items-center gap-3">
        {state?.error ? <span className="text-xs text-danger">{state.error}</span> : null}
        <form action={formAction}>
          <Button type="submit" variant="outline" size="sm" disabled={isPending}>
            {isPending ? "Revoking…" : "Revoke"}
          </Button>
        </form>
      </div>
    </li>
  );
}
