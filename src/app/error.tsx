"use client";

import { PaynoraMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

/**
 * The root error boundary — Next.js requires this to be a Client
 * Component. Never claims success: this only renders when something
 * genuinely threw, and it says so plainly rather than showing a blank or
 * misleadingly cheerful screen. See docs/product-ui.md#error-states.
 */
export default function RootError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 bg-background px-6 py-24 text-center">
      <PaynoraMark size={36} />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Something went wrong</h1>
        <p className="mt-2 max-w-sm text-sm text-muted">
          An unexpected error occurred. You can try again, or come back later.
        </p>
      </div>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
