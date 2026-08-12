import Link from "next/link";

import { PaynoraMark } from "@/components/brand/logo";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function RootNotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 bg-background px-6 py-24 text-center">
      <PaynoraMark size={36} />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Page not found</h1>
        <p className="mt-2 text-sm text-muted">The page you&rsquo;re looking for doesn&rsquo;t exist.</p>
      </div>
      <Link href="/" className={cn(buttonVariants())}>
        Back to PAYNORA
      </Link>
    </div>
  );
}
