"use client";

import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { GlassCard } from "@/components/ui/glass-card";
import { cn } from "@/lib/utils";
import type { CopilotQuestionType } from "@/server/copilot/service";
import { askCopilotAction, type CopilotAskResult } from "@/app/app/[orgSlug]/copilot-actions";

export type CopilotQuestion = { type: CopilotQuestionType; label: string };

/**
 * Phase 22 — the one Copilot UI surface, embedded wherever a page has a
 * grounded question to offer (Overview, Invoice detail, Customer detail,
 * Action Center). Deliberately a fixed set of buttons, never a free-text
 * box — see src/server/copilot/service.ts's own doc comment for why: no
 * user-authored prompt surface exists for injection to exploit, and every
 * question already has a real, deterministic answer behind it. `targetId`
 * is passed straight through to the Server Action, itself re-scoped by
 * `organizationId` server-side — this component never trusts anything
 * about its own answer beyond what the action returns.
 */
export function CopilotPanel({
  orgSlug,
  targetId,
  questions,
}: {
  orgSlug: string;
  targetId?: string;
  questions: CopilotQuestion[];
}) {
  const [isPending, startTransition] = useTransition();
  const [activeQuestion, setActiveQuestion] = useState<CopilotQuestionType | null>(null);
  const [result, setResult] = useState<CopilotAskResult | null>(null);

  function ask(question: CopilotQuestionType) {
    setActiveQuestion(question);
    startTransition(async () => {
      const answer = await askCopilotAction(orgSlug, question, targetId);
      setResult(answer);
    });
  }

  return (
    <GlassCard level={2} className="flex flex-col gap-3 p-5">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Ask PAYNORA</h3>
      </div>
      <div className="flex flex-wrap gap-2">
        {questions.map((q) => (
          <button
            key={q.type}
            type="button"
            disabled={isPending}
            onClick={() => ask(q.type)}
            className={cn(
              buttonVariants({ variant: activeQuestion === q.type ? "primary" : "outline", size: "sm" }),
              "text-xs",
            )}
          >
            {q.label}
          </button>
        ))}
      </div>

      {isPending ? <p className="text-xs text-muted">Thinking…</p> : null}

      {!isPending && result ? <CopilotAnswerView result={result} orgSlug={orgSlug} /> : null}
    </GlassCard>
  );
}

function CopilotAnswerView({ result, orgSlug }: { result: CopilotAskResult; orgSlug: string }) {
  if (result.status === "not_entitled") {
    return (
      <Alert tone="info">
        Ask PAYNORA isn&rsquo;t available on this organization&rsquo;s current plan.{" "}
        <a href={`/app/${orgSlug}/settings?tab=billing`} className="font-medium underline">
          View plans
        </a>
      </Alert>
    );
  }
  if (result.status === "not_found") {
    return <Alert tone="warning">That item is no longer available.</Alert>;
  }
  if (result.status === "error") {
    return <Alert tone="danger">Couldn&rsquo;t answer that right now — please try again.</Alert>;
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-surface-raised/60 p-3.5 text-sm">
      <p className="text-foreground">{result.aiAnswer ?? result.deterministicAnswer}</p>
      {result.aiGenerated ? (
        <Badge tone="neutral" className="self-start">
          AI-worded
        </Badge>
      ) : null}
    </div>
  );
}
