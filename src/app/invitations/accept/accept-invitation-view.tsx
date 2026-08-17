"use client";

import { useActionState } from "react";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { acceptInvitationAction } from "./actions";

export function AcceptInvitationView({
  token,
  organizationName,
  roleLabel,
  invitedEmail,
  signedInEmail,
}: {
  token: string;
  organizationName: string;
  roleLabel: string;
  invitedEmail: string;
  signedInEmail: string | null;
}) {
  const boundAction = acceptInvitationAction.bind(null, token);
  const [state, formAction, isPending] = useActionState(boundAction, null);

  const signInHref = `/sign-in?callbackUrl=${encodeURIComponent(`/invitations/accept?token=${token}`)}`;
  const signUpHref = `/sign-up?callbackUrl=${encodeURIComponent(`/invitations/accept?token=${token}`)}`;

  if (!signedInEmail) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">You&apos;re invited</h1>
        <p className="mt-2 text-sm text-muted">
          You&apos;ve been invited to join <span className="font-medium text-foreground">{organizationName}</span> on
          PAYNORA as {roleLabel}. Sign in or create an account with <span className="font-medium">{invitedEmail}</span>{" "}
          to accept.
        </p>
        <div className="mt-8 flex flex-col gap-3">
          <Link href={signInHref} className={cn(buttonVariants({ size: "lg" }), "w-full")}>
            Sign in
          </Link>
          <Link href={signUpHref} className={cn(buttonVariants({ size: "lg", variant: "outline" }), "w-full")}>
            Create an account
          </Link>
        </div>
      </div>
    );
  }

  if (signedInEmail !== invitedEmail) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Wrong account</h1>
        <Alert tone="warning" className="mt-8">
          This invitation was sent to {invitedEmail}, but you&apos;re signed in as {signedInEmail}. Sign out and sign
          in with the invited email address to accept.
        </Alert>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">You&apos;re invited</h1>
      <p className="mt-2 text-sm text-muted">
        Join <span className="font-medium text-foreground">{organizationName}</span> on PAYNORA as {roleLabel}.
      </p>

      <form action={formAction} className="mt-8 flex flex-col gap-4">
        {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
        <Button type="submit" size="lg" disabled={isPending}>
          {isPending ? "Joining…" : "Accept invitation"}
        </Button>
      </form>
    </div>
  );
}
