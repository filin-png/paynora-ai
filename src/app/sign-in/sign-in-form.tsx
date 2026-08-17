"use client";

import { useActionState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signInAction } from "./actions";

export function SignInForm({ callbackUrl }: { callbackUrl: string }) {
  const [state, formAction, isPending] = useActionState(signInAction, null);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Welcome back</h1>
      <p className="mt-2 text-sm text-muted">
        Don&apos;t have an account?{" "}
        <Link href="/sign-up" className="font-medium text-primary hover:underline">
          Create one
        </Link>
      </p>

      <form action={formAction} className="mt-8 flex flex-col gap-4">
        <input type="hidden" name="callbackUrl" value={callbackUrl} />

        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link href="/forgot-password" className="text-xs font-medium text-primary hover:underline">
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={state?.error ? true : undefined}
          />
        </div>

        {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}

        <Button type="submit" disabled={isPending} size="lg" className="mt-2">
          {isPending ? "Signing in…" : "Sign in"}
          {!isPending ? <ArrowRight className="size-4" /> : null}
        </Button>
      </form>
    </div>
  );
}
