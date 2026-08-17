"use client";

import { useActionState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resetPasswordAction } from "./actions";

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction, isPending] = useActionState(resetPasswordAction, null);

  if (!token) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Invalid link</h1>
        <Alert tone="danger" className="mt-8">
          This password reset link is invalid or has expired.
        </Alert>
        <p className="mt-6 text-sm text-muted">
          <Link href="/forgot-password" className="font-medium text-primary hover:underline">
            Request a new link
          </Link>
        </p>
      </div>
    );
  }

  if (state?.tone === "success") {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Password reset</h1>
        <Alert tone="success" className="mt-8">
          {state.message}
        </Alert>
        <p className="mt-6 text-sm text-muted">
          <Link href="/sign-in" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Choose a new password</h1>
      <p className="mt-2 text-sm text-muted">Enter a new password for your account.</p>

      <form action={formAction} className="mt-8 flex flex-col gap-4">
        <input type="hidden" name="token" value={token} />

        <div className="flex flex-col gap-2">
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            aria-describedby="password-hint"
            aria-invalid={state?.tone === "danger" ? true : undefined}
          />
          <p id="password-hint" className="text-xs text-muted">
            At least 8 characters.
          </p>
        </div>

        {state?.tone === "danger" ? <Alert tone="danger">{state.message}</Alert> : null}

        <Button type="submit" disabled={isPending} size="lg" className="mt-2">
          {isPending ? "Resetting…" : "Reset password"}
          {!isPending ? <ArrowRight className="size-4" /> : null}
        </Button>
      </form>
    </div>
  );
}
