import {
  BellRing,
  CircleDollarSign,
  Eye,
  Search,
  Send,
  Sparkles,
  UserCheck,
} from "lucide-react";

const storySteps = [
  {
    icon: BellRing,
    title: "An invoice becomes overdue",
    description: "PAYNORA already knows — outstanding balance and days overdue are computed live from your real invoice data, not a nightly batch job.",
  },
  {
    icon: Search,
    title: "PAYNORA detects the risk",
    description: "A deterministic check flags it: overdue, still unpaid, worth attention now — not a guess, a fact about the invoice.",
  },
  {
    icon: Sparkles,
    title: "PAYNORA recommends the next action",
    description: "A specific, ready-to-send reminder is drafted — the right tone for how overdue it is, with the actual invoice context.",
  },
  {
    icon: UserCheck,
    title: "A human approves — when required",
    description: "Every recommendation is editable and needs an explicit decision by default. Nothing goes out until someone says so.",
  },
  {
    icon: Send,
    title: "The follow-up is sent",
    description: "Once approved, PAYNORA sends it and reports back honestly — including when delivery genuinely can't be confirmed.",
  },
  {
    icon: CircleDollarSign,
    title: "Payment arrives",
    description: "A recorded payment updates the invoice instantly — partial or full, in the invoice's own currency, never estimated.",
  },
  {
    icon: Eye,
    title: "Receivables become visible and controllable",
    description: "The dashboard, the invoice, and the customer's history all reflect it immediately — one current picture, not a stale export.",
  },
] as const;

export function WorkflowStory() {
  return (
    <ol className="relative mt-14 flex flex-col">
      <span
        aria-hidden="true"
        className="absolute top-2 bottom-2 left-[19px] w-px bg-gradient-to-b from-primary/60 via-border-strong to-transparent sm:left-[23px]"
      />
      {storySteps.map((step, index) => (
        <li
          key={step.title}
          className="reveal-on-scroll relative flex gap-5 pb-10 last:pb-0 sm:gap-6"
          style={{ animationDelay: `${index * 60}ms` }}
        >
          <span className="relative z-10 flex size-10 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface shadow-card-sm sm:size-12">
            <step.icon className="size-4.5 text-primary sm:size-5" />
          </span>
          <div className="flex flex-col gap-1 pt-1">
            <span className="font-[family-name:var(--font-landing-mono)] text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {String(index + 1).padStart(2, "0")}
            </span>
            <h3 className="font-[family-name:var(--font-landing-display)] text-base font-medium text-foreground sm:text-lg">
              {step.title}
            </h3>
            <p className="max-w-xl text-sm leading-6 text-muted">{step.description}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
