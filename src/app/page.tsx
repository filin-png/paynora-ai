import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  CircleCheck,
  Landmark,
  Layers,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
  Zap,
} from "lucide-react";

import { PaynoraLogo } from "@/components/brand/logo";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const workflowSteps = [
  {
    icon: Landmark,
    title: "Track receivables",
    description: "Every invoice, its outstanding balance, and how overdue it is — computed live, in one place.",
  },
  {
    icon: Sparkles,
    title: "PAYNORA detects & recommends",
    description: "Overdue invoices generate a suggested action — a reminder, with context, not a guess.",
  },
  {
    icon: Users,
    title: "A human reviews",
    description: "Every suggestion is editable and requires explicit approval — nothing is decided for you.",
  },
  {
    icon: Workflow,
    title: "Send, or automate follow-up",
    description: "Approve and send once, or opt in to a collection policy that follows up on a schedule.",
  },
];

const trustPoints = [
  {
    icon: ShieldCheck,
    title: "Approval by default",
    description: "Automated sending is opt-in, per policy, and always reversible before it happens.",
  },
  {
    icon: BadgeCheck,
    title: "Server-side authorization",
    description: "Every action is verified against your organization membership — never trusted from the browser.",
  },
  {
    icon: CircleCheck,
    title: "Honest delivery status",
    description: "If we can't confirm an email was delivered, we say so — never a false \"sent\" or silent retry.",
  },
];

const providers = [
  { name: "AI", detail: "OpenRouter, Mistral — provider-ready" },
  { name: "Email", detail: "SMTP, works with any provider" },
  { name: "Messaging", detail: "Telegram — integration foundation" },
  { name: "Billing", detail: "Stripe, YooKassa — coming" },
];

export default function LandingPage() {
  return (
    <div className="flex flex-1 flex-col bg-background">
      <SiteHeader />
      <Hero />
      <ProblemSection />
      <WorkflowSection />
      <CollectionsSection />
      <ProvidersSection />
      <TrustSection />
      <FinalCta />
      <SiteFooter />
    </div>
  );
}

function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-4 sm:px-6">
        <PaynoraLogo size={24} />
        <nav className="flex items-center gap-2 sm:gap-4">
          <Link
            href="/sign-in"
            className="hidden text-sm font-medium text-foreground hover:text-primary sm:inline"
          >
            Sign in
          </Link>
          <Link href="/sign-up" className={cn(buttonVariants({ size: "sm" }))}>
            Get started
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden bg-navy-950">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgba(106,99,224,0.25),transparent)]"
      />
      <div className="relative mx-auto grid w-full max-w-6xl gap-12 px-5 py-20 sm:px-6 sm:py-28 lg:grid-cols-2 lg:items-center lg:py-32">
        <div className="flex flex-col gap-6">
          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-navy-muted">
            <Zap className="size-3.5" />
            Accounts receivable, under control
          </span>
          <h1 className="max-w-xl text-4xl font-semibold tracking-tight text-balance text-white sm:text-5xl">
            Get paid faster.
            <br />
            Chase invoices less.
          </h1>
          <p className="max-w-lg text-lg leading-8 text-navy-muted">
            PAYNORA helps B2B companies stay on top of accounts receivable, automate
            follow-ups on overdue invoices, and keep a human in the loop exactly where
            it matters — without replacing the accounting software you already use.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Link href="/sign-up" className={cn(buttonVariants({ size: "lg" }))}>
              Start free
              <ArrowRight className="size-4" />
            </Link>
            <Link
              href="#how-it-works"
              className={cn(buttonVariants({ variant: "outline", size: "lg" }), "border-white/20 bg-transparent text-white hover:bg-white/10")}
            >
              See how it works
            </Link>
          </div>
        </div>

        <HeroVisual />
      </div>
    </section>
  );
}

/**
 * Illustrative marketing visual — deliberately built from generic sample
 * values, not real user data (this renders on the public, unauthenticated
 * landing page). Pure CSS transforms/layered cards, no 3D engine — see
 * docs/product-ui.md#marketing-illustrations-vs-real-data.
 */
function HeroVisual() {
  return (
    <div className="relative mx-auto hidden h-96 w-full max-w-md [perspective:1400px] lg:block" aria-hidden="true">
      <div className="absolute inset-0 [transform-style:preserve-3d] [transform:rotateY(-10deg)_rotateX(6deg)]">
        <div className="absolute left-6 top-16 w-64 rounded-xl border border-white/10 bg-navy-800/90 p-4 shadow-card-lg backdrop-blur [transform:translateZ(0px)]">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-navy-muted">INV-1048</span>
            <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[10px] font-medium text-danger">Overdue 12d</span>
          </div>
          <p className="mt-3 text-lg font-semibold text-white">$12,450.00</p>
          <p className="mt-1 text-xs text-navy-muted">Acme Manufacturing Ltd</p>
        </div>

        <div className="absolute right-2 top-0 w-56 rounded-xl border border-white/10 bg-navy-700/90 p-4 shadow-card-lg backdrop-blur [transform:translateZ(60px)]">
          <div className="flex items-center gap-2">
            <Sparkles className="size-3.5 text-primary-hover" />
            <span className="text-xs font-medium text-white">Suggested action</span>
          </div>
          <p className="mt-2 text-xs leading-5 text-navy-muted">
            Send a firm reminder — 3rd follow-up, invoice 12 days overdue.
          </p>
          <div className="mt-3 flex gap-2">
            <span className="rounded-md bg-primary px-2 py-1 text-[10px] font-medium text-white">Approve</span>
            <span className="rounded-md border border-white/15 px-2 py-1 text-[10px] font-medium text-navy-muted">Edit</span>
          </div>
        </div>

        <div className="absolute bottom-4 left-16 w-52 rounded-xl border border-white/10 bg-navy-800/90 p-4 shadow-card-lg backdrop-blur [transform:translateZ(110px)]">
          <span className="text-xs font-medium text-navy-muted">Collected this month</span>
          <p className="mt-2 text-2xl font-semibold text-white">$84,200</p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div className="h-full w-4/5 rounded-full bg-success" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ProblemSection() {
  return (
    <section className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-6">
      <div className="grid gap-10 sm:grid-cols-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">The problem</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
            Manual receivables tracking doesn&rsquo;t scale.
          </h2>
        </div>
        <div className="flex flex-col gap-2 sm:col-span-2 sm:grid sm:grid-cols-2 sm:gap-8">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Spreadsheets fall behind</h3>
            <p className="mt-1.5 text-sm leading-6 text-muted">
              By the time you notice an invoice is overdue, it&rsquo;s already been ignored twice.
            </p>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Follow-up is inconsistent</h3>
            <p className="mt-1.5 text-sm leading-6 text-muted">
              Some customers get chased immediately, others get forgotten — with no record of why.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function WorkflowSection() {
  return (
    <section id="how-it-works" className="border-y border-border bg-surface py-20">
      <div className="mx-auto w-full max-w-6xl px-5 sm:px-6">
        <div className="max-w-xl">
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">How it works</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            Detection, recommendation, human approval — in that order.
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted">
            PAYNORA never sends anything on its own. It surfaces what needs attention and
            drafts the follow-up — you decide what actually goes out.
          </p>
        </div>

        <ol className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {workflowSteps.map((step, index) => (
            <li key={step.title} className="relative flex flex-col gap-3 rounded-xl border border-border bg-background p-5">
              <span className="flex size-9 items-center justify-center rounded-lg bg-accent-soft text-primary">
                <step.icon className="size-4.5" />
              </span>
              <span className="text-xs font-medium text-muted-foreground">Step {index + 1}</span>
              <h3 className="text-sm font-semibold text-foreground">{step.title}</h3>
              <p className="text-sm leading-6 text-muted">{step.description}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function CollectionsSection() {
  return (
    <section className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-6">
      <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">Collections automation</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            Define the follow-up. PAYNORA keeps it running.
          </h2>
          <p className="mt-4 text-sm leading-7 text-muted">
            Set a policy for how overdue invoices should be followed up — a friendly
            reminder, then a follow-up, then a firmer one. Every step still requires
            approval by default; automatic sending is an explicit, reversible opt-in per
            policy, and every run re-checks the invoice is still actually overdue before
            doing anything.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-6 shadow-card-md">
          <ol className="relative flex flex-col gap-6 pl-6">
            <span aria-hidden="true" className="absolute top-1 bottom-1 left-[7px] w-px bg-border-strong" />
            {[
              { day: "Due date", label: "Invoice becomes due" },
              { day: "+1 day", label: "Friendly reminder" },
              { day: "+3 days", label: "Follow-up" },
              { day: "+7 days", label: "Firm reminder" },
            ].map((step) => (
              <li key={step.day} className="relative flex items-baseline gap-4">
                <span aria-hidden="true" className="absolute -left-6 top-1.5 size-2.5 rounded-full border-2 border-primary bg-background" />
                <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">{step.day}</span>
                <span className="text-sm font-medium text-foreground">{step.label}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

function ProvidersSection() {
  return (
    <section className="border-y border-border bg-surface py-20">
      <div className="mx-auto w-full max-w-6xl px-5 sm:px-6">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">Built to integrate</p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              An integration-ready foundation.
            </h2>
          </div>
          <Layers className="hidden size-8 text-muted-foreground sm:block" />
        </div>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-muted">
          PAYNORA is designed to work with the tools you already use, without locking you
          into one vendor. Some connections are live today; others are architected and
          ready to be connected — we&rsquo;re explicit about which is which.
        </p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {providers.map((provider) => (
            <div key={provider.name} className="rounded-xl border border-border bg-background p-5">
              <p className="text-sm font-semibold text-foreground">{provider.name}</p>
              <p className="mt-1.5 text-xs leading-5 text-muted">{provider.detail}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function TrustSection() {
  return (
    <section className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-6">
      <p className="text-xs font-semibold uppercase tracking-wide text-primary">Security &amp; trust</p>
      <h2 className="mt-3 max-w-xl text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
        Financial data deserves a serious security posture.
      </h2>
      <div className="mt-10 grid gap-8 sm:grid-cols-3">
        {trustPoints.map((point) => (
          <div key={point.title} className="flex flex-col gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-success-soft text-success">
              <point.icon className="size-4.5" />
            </span>
            <h3 className="text-sm font-semibold text-foreground">{point.title}</h3>
            <p className="text-sm leading-6 text-muted">{point.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="bg-navy-950">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-6 px-5 py-20 text-center sm:px-6">
        <h2 className="max-w-xl text-3xl font-semibold tracking-tight text-white">
          Take control of your receivables.
        </h2>
        <p className="max-w-md text-sm leading-6 text-navy-muted">
          Create an account and see your outstanding invoices in one place — no credit
          card required.
        </p>
        <Link href="/sign-up" className={cn(buttonVariants({ size: "lg" }))}>
          Create your account
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-5 py-8 text-sm text-muted sm:flex-row sm:px-6">
        <PaynoraLogo size={20} className="opacity-80" />
        <p>© {new Date().getFullYear()} PAYNORA. All rights reserved.</p>
      </div>
    </footer>
  );
}
