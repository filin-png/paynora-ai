"use client";

import { useActionState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signUpAction } from "./actions";

export function SignUpForm({ callbackUrl = "/app" }: { callbackUrl?: string }) {
  const [state, formAction, isPending] = useActionState(signUpAction, null);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Create your account</h1>
      <p className="mt-2 text-sm text-muted">
        Already have an account?{" "}
        <Link href="/sign-in" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>

      <form action={formAction} className="mt-8 flex flex-col gap-4">
        <input type="hidden" name="callbackUrl" value={callbackUrl} />

        <div className="flex flex-col gap-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" type="text" autoComplete="name" />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            aria-describedby="password-hint"
            aria-invalid={state?.error ? true : undefined}
          />
          <p id="password-hint" className="text-xs text-muted">
            At least 8 characters.
          </p>
        </div>

        {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}

        <Button type="submit" disabled={isPending} size="lg" className="mt-2">
          {isPending ? "Creating account…" : "Create account"}
          {!isPending ? <ArrowRight className="size-4" /> : null}
        </Button>

        <p className="text-center text-xs text-muted">
          By creating an account, you agree to our{" "}
          <Link href="/terms-of-service" className="font-medium text-primary hover:underline">
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link href="/privacy-policy" className="font-medium text-primary hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
      </form>
    </div>
  );
}
