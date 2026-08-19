import Link from "next/link";
import { Check, ChevronRight, Lock } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getOnboardingState } from "@/server/onboarding/service";

/**
 * A `<details>`-based checklist — no client JS needed for expand/collapse.
 * Expanded by default until every achievable step is done, then collapsed
 * by default but still one click away (Phase 11.4 brief, section 2:
 * "collapse appropriately... but remain accessible").
 */
export async function OnboardingChecklist({
  organizationId,
  orgSlug,
}: {
  organizationId: string;
  orgSlug: string;
}) {
  const state = await getOnboardingState(organizationId, orgSlug);
  const percent = Math.round((state.completedCount / state.totalSteps) * 100);

  return (
    <Card className="overflow-hidden p-0">
      <details open={!state.isComplete} className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-4 [&::-webkit-details-marker]:hidden">
          <div>
            <p className="text-sm font-semibold text-foreground">Getting started</p>
            <p className="text-xs text-muted">
              {state.completedCount} of {state.totalSteps} steps complete
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="h-1.5 w-20 overflow-hidden rounded-full bg-accent-soft sm:w-28">
              <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
            </div>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          </div>
        </summary>
        <ul className="divide-y divide-border border-t border-border">
          {state.steps.map((step) => (
            <li key={step.id} className="flex flex-col items-start justify-between gap-3 px-6 py-3.5 text-sm sm:flex-row sm:items-center">
              <div className="flex items-start gap-3">
                <span
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
                    step.completed ? "bg-success text-white" : "bg-accent-soft text-muted-foreground",
                  )}
                >
                  {step.completed ? <Check className="size-3" /> : step.locked ? <Lock className="size-3" /> : null}
                </span>
                <div>
                  <p className={cn("font-medium", step.completed ? "text-muted-foreground line-through" : "text-foreground")}>
                    {step.title}
                  </p>
                  <p className="text-xs text-muted">{step.description}</p>
                </div>
              </div>
              {!step.completed ? (
                <Link href={step.ctaHref} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}>
                  {step.ctaLabel}
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}
