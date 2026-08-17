"use client";

import { useActionState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { forgotPasswordAction } from "./actions";

export function ForgotPasswordForm() {
  const [state, formAction, isPending] = useActionState(forgotPasswordAction, null);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Reset your password</h1>
      <p className="mt-2 text-sm text-muted">
        Enter the email address on your account and we&apos;ll send you a link to reset your password.
      </p>

      {state?.tone === "success" ? (
        <Alert tone="success" className="mt-8">
          {state.message}
        </Alert>
      ) : (
        <form action={formAction} className="mt-8 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>

          {state?.tone === "danger" ? <Alert tone="danger">{state.message}</Alert> : null}

          <Button type="submit" disabled={isPending} size="lg" className="mt-2">
            {isPending ? "Sending…" : "Send reset link"}
            {!isPending ? <ArrowRight className="size-4" /> : null}
          </Button>
        </form>
      )}

      <p className="mt-6 text-sm text-muted">
        <Link href="/sign-in" className="font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
