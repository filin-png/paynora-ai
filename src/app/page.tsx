import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  CircleCheck,
  Layers,
  Lock,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import { PaynoraLogo } from "@/components/brand/logo";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { buttonVariants } from "@/components/ui/button";
import { bodyFont, displayFont, monoFont } from "@/components/marketing/fonts";
import { HeroVisual } from "@/components/marketing/hero-visual";
import { PulseDot, PulseLine } from "@/components/marketing/pulse";
import { WorkflowStory } from "@/components/marketing/workflow-story";
import { ActionCenterMockup, DashboardMockup } from "@/components/marketing/feature-mockups";
import { getDictionary, type Dictionary, type Locale } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/get-locale";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/server/ar/money";
import { PLAN_ENTITLEMENTS, PLAN_ORDER } from "@/server/billing/plans";
import { formatPlanLimit, PLAN_BLURB, PLAN_LABEL } from "@/components/billing/plan-labels";

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
    icon: Lock,
    title: "Organization isolation",
    description: "Every query is scoped to your organization at the data layer — tested so one tenant can never read another's.",
  },
  {
    icon: CircleCheck,
    title: "Honest delivery status",
    description: "If we can't confirm an email was delivered, we say so — never a false \"sent\" or silent retry.",
  },
];

const providers = [
  { name: "AI", detail: "OpenRouter, Mistral — provider-ready" },
  { name: "Email", detail: "SMTP — works with any provider" },
  { name: "Messaging", detail: "Telegram — integration foundation" },
  { name: "Billing", detail: "Stripe, YooKassa — coming" },
];

export default async function LandingPage() {
  const locale = await getLocale();
  const dict = getDictionary(locale);

  return (
    <div
      className={cn(
        "flex flex-1 flex-col bg-background",
        displayFont.variable,
        bodyFont.variable,
        monoFont.variable,
      )}
      style={{ fontFamily: "var(--font-landing-body), var(--font-sans)" }}
    >
      <SiteNav locale={locale} dict={dict} />
      <main className="flex flex-1 flex-col">
        <Hero dict={dict} />
        <ProblemSection />
        <WorkflowSection />
        <ActionCenterSection />
        <CollectionsSection />
        <VisibilitySection />
        <ProvidersSection />
        <PlansSection />
        <TrustSection />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}

function SiteNav({ locale, dict }: { locale: Locale; dict: Dictionary }) {
  return (
    <header className="sticky top-3 z-30 px-4 sm:top-4 sm:px-6">
      <div className="glass-surface mx-auto flex w-full max-w-6xl items-center justify-between rounded-2xl px-4 py-2.5 shadow-card-md sm:px-5">
        <PaynoraLogo size={24} />
        <nav className="flex items-center gap-2 sm:gap-4">
          <LocaleSwitcher locale={locale} />
          <Link
            href="/sign-in"
            className="hidden text-sm font-medium text-foreground hover:text-primary sm:inline"
          >
            {dict.common.signIn}
          </Link>
          <Link href="/sign-up" className={cn(buttonVariants({ variant: "premium", size: "sm" }))}>
            {dict.common.getStarted}
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Hero({ dict }: { dict: Dictionary }) {
  return (
    <section className="relative overflow-hidden bg-navy-950">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgba(106,99,224,0.28),transparent)]"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
        }}
      />
      <div className="relative mx-auto grid w-full max-w-6xl gap-14 px-5 pt-16 pb-20 sm:px-6 sm:pt-20 sm:pb-28 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:gap-10 lg:py-32">
        <div className="flex flex-col gap-6">
          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-navy-muted">
            <PulseDot />
            {dict.landing.badge}
          </span>
          <h1 className="max-w-xl font-[family-name:var(--font-landing-display)] text-4xl font-medium tracking-tight text-balance text-white sm:text-5xl lg:text-[3.4rem] lg:leading-[1.06]">
            {dict.landing.heroTitlePrefix}{" "}
            <span className="bg-[linear-gradient(120deg,var(--primary-hover),var(--secondary)_65%,var(--accent-cyan))] bg-clip-text text-transparent">
              {dict.landing.heroTitleHighlight}
            </span>
            {dict.landing.heroTitleSuffix}
          </h1>
          <p className="max-w-lg text-lg leading-8 text-navy-muted">{dict.landing.heroSubtitle}</p>
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Link href="/sign-up" className={cn(buttonVariants({ variant: "premium", size: "lg" }))}>
              {dict.common.getStarted}
              <ArrowRight className="size-4" />
            </Link>
            <Link
              href="#how-it-works"
              className={cn(
                buttonVariants({ variant: "outline", size: "lg" }),
                "border-white/20 bg-transparent text-white hover:bg-white/10",
              )}
            >
              See how it works
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-4 text-xs text-navy-muted">
            <span>No credit card required</span>
            <span className="hidden size-1 rounded-full bg-navy-muted/60 sm:inline-block" />
            <span>Your accounting software stays the system of record</span>
          </div>
        </div>

        <HeroVisual />
      </div>
      {/* "The Pulse" — PAYNORA's signature live-data trace, see
          docs/product-ui.md#design-system. Runs along the empty margin
          below the hero content (not behind the composition's near-opaque
          cards, where it would be invisible). */}
      <PulseLine className="inset-x-0 bottom-2 h-28 opacity-90" />
    </section>
  );
}

function ProblemSection() {
  return (
    <section className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-6 sm:py-24">
      <div className="grid gap-10 sm:grid-cols-3">
        <div className="reveal-on-scroll">
          <p className="font-[family-name:var(--font-landing-mono)] text-xs font-medium tracking-wide text-primary uppercase">
            The problem
          </p>
          <h2 className="mt-3 font-[family-name:var(--font-landing-display)] text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
            Manual receivables tracking doesn&rsquo;t scale.
          </h2>
        </div>
        <div className="flex flex-col gap-8 sm:col-span-2 sm:grid sm:grid-cols-2 sm:gap-8">
          <div className="reveal-on-scroll" style={{ animationDelay: "80ms" }}>
            <h3 className="text-sm font-semibold text-foreground">Spreadsheets fall behind</h3>
            <p className="mt-1.5 text-sm leading-6 text-muted">
              By the time you notice an invoice is overdue, it&rsquo;s already been ignored twice.
            </p>
          </div>
          <div className="reveal-on-scroll" style={{ animationDelay: "160ms" }}>
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
    <section id="how-it-works" className="border-y border-border bg-surface py-20 sm:py-24">
      <div className="mx-auto w-full max-w-6xl px-5 sm:px-6">
        <div className="reveal-on-scroll max-w-xl">
          <p className="font-[family-name:var(--font-landing-mono)] text-xs font-medium tracking-wide text-primary uppercase">
            How it works
          </p>
          <h2 className="mt-3 font-[family-name:var(--font-landing-display)] text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
            From overdue invoice to controlled outcome.
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted">
            PAYNORA never sends anything on its own. It watches, recommends, and — once a
            human decides — carries the decision through. Every stage below is a real part
            of the product, not a roadmap slide.
          </p>
        </div>

        <WorkflowStory />
      </div>
    </section>
  );
}

function ActionCenterSection() {
  return (
    <section className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-6 sm:py-24">
      <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
        <div className="reveal-on-scroll order-2 lg:order-1">
          <ActionCenterMockup />
        </div>
        <div className="order-1 lg:order-2">
          <p className="font-[family-name:var(--font-landing-mono)] text-xs font-medium tracking-wide text-primary uppercase">
            Action Center
          </p>
          <h2 className="mt-3 font-[family-name:var(--font-landing-display)] text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
            Human-in-the-loop, not human-instead-of.
          </h2>
          <p className="mt-4 text-sm leading-7 text-muted">
            Every recommendation PAYNORA makes lands in one place, with the reasoning behind
            it. Approve it as written, edit the wording first, or dismiss it — approving
            never sends anything by itself; sending is a separate, explicit step you take
            after reviewing the actual message.
          </p>
        </div>
      </div>
    </section>
  );
}

function CollectionsSection() {
  return (
    <section className="border-y border-border bg-surface py-20 sm:py-24">
      <div className="mx-auto w-full max-w-6xl px-5 sm:px-6">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <p className="font-[family-name:var(--font-landing-mono)] text-xs font-medium tracking-wide text-primary uppercase">
              Collections automation
            </p>
            <h2 className="mt-3 font-[family-name:var(--font-landing-display)] text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
              Define the follow-up. PAYNORA keeps it running.
            </h2>
            <p className="mt-4 text-sm leading-7 text-muted">
              Set a policy for how overdue invoices should be followed up — a friendly
              reminder, then a follow-up, then a firmer one. Every step still requires
              approval by default, and every run re-checks the invoice is still actually
              overdue before doing anything.
            </p>
            <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <p className="text-xs leading-5 text-warning">
                Auto-send is a separate, explicit opt-in — off by default, owner-only, and
                reversible at any time. Turning it on is a deliberate decision, never a default.
              </p>
            </div>
          </div>
          <div className="reveal-on-scroll glass-surface rounded-2xl p-6 shadow-card-md">
            <ol className="relative flex flex-col gap-6 pl-6">
              <span aria-hidden="true" className="absolute top-1 bottom-1 left-[7px] w-px bg-border-strong" />
              {[
                { day: "Due date", label: "Invoice becomes due" },
                { day: "+1 day", label: "Friendly reminder" },
                { day: "+3 days", label: "Follow-up" },
                { day: "+7 days", label: "Firm reminder" },
              ].map((step) => (
                <li key={step.day} className="relative flex items-baseline gap-4">
                  <span aria-hidden="true" className="absolute -left-6 top-1.5 size-2.5 rounded-full border-2 border-primary bg-surface" />
                  <span className="w-20 shrink-0 font-[family-name:var(--font-landing-mono)] text-xs font-medium text-muted-foreground">
                    {step.day}
                  </span>
                  <span className="text-sm font-medium text-foreground">{step.label}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

function VisibilitySection() {
  return (
    <section className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-6 sm:py-24">
      <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
        <div>
          <p className="font-[family-name:var(--font-landing-mono)] text-xs font-medium tracking-wide text-primary uppercase">
            Financial visibility
          </p>
          <h2 className="mt-3 font-[family-name:var(--font-landing-display)] text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
            One current picture of what you&rsquo;re owed.
          </h2>
          <p className="mt-4 text-sm leading-7 text-muted">
            Outstanding and overdue totals, grouped by currency and computed live — never a
            stale export. See what needs attention now, what&rsquo;s coming due, and what
            you&rsquo;ve actually recovered.
          </p>
        </div>
        <div className="reveal-on-scroll">
          <DashboardMockup />
        </div>
      </div>
    </section>
  );
}

function ProvidersSection() {
  return (
    <section className="border-y border-border bg-surface py-20 sm:py-24">
      <div className="mx-auto w-full max-w-6xl px-5 sm:px-6">
        <div className="flex items-end justify-between gap-4">
          <div className="reveal-on-scroll">
            <p className="font-[family-name:var(--font-landing-mono)] text-xs font-medium tracking-wide text-primary uppercase">
              Built to integrate
            </p>
            <h2 className="mt-3 font-[family-name:var(--font-landing-display)] text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
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
          {providers.map((provider, index) => (
            <div
              key={provider.name}
              className="reveal-on-scroll glass-surface rounded-xl p-5 transition-colors hover:border-primary/30"
              style={{ animationDelay: `${index * 60}ms` }}
            >
              <p className="text-sm font-semibold text-foreground">{provider.name}</p>
              <p className="mt-1.5 text-xs leading-5 text-muted">{provider.detail}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * Reads `PLAN_ENTITLEMENTS` (src/server/billing/plans.ts) directly — the
 * same authoritative catalog every server-side enforcement point and the
 * Settings → Billing plan comparison read, so a number changed there is
 * never out of sync with what a visitor sees here (Phase 11.4 brief,
 * section 5/7). No checkout: every plan links to sign-up, and plan changes
 * today are handled by PAYNORA directly — see the Settings → Billing tab
 * once signed in.
 */
function PlansSection() {
  return (
    <section id="plans" className="border-y border-border bg-surface py-20 sm:py-24">
      <div className="mx-auto w-full max-w-6xl px-5 sm:px-6">
        <div className="reveal-on-scroll max-w-xl">
          <p className="font-[family-name:var(--font-landing-mono)] text-xs font-medium tracking-wide text-primary uppercase">
            Plans
          </p>
          <h2 className="mt-3 font-[family-name:var(--font-landing-display)] text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
            Start free. Grow into more as your book of business grows.
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted">
            No credit card required to start. Online billing isn&rsquo;t connected yet — plan changes today are
            handled by PAYNORA directly, not through a self-serve checkout.
          </p>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PLAN_ORDER.map((planId, index) => {
            const entitlements = PLAN_ENTITLEMENTS[planId];
            return (
              <div
                key={planId}
                className="reveal-on-scroll glass-elevated flex flex-col gap-4 rounded-2xl p-6"
                style={{ animationDelay: `${index * 60}ms` }}
              >
                <div>
                  <p className="text-sm font-semibold text-foreground">{PLAN_LABEL[planId]}</p>
                  <p className="mt-2 text-lg font-semibold tracking-tight text-foreground">
                    {entitlements.priceMinor === 0n
                      ? "Free"
                      : `${formatMoney(entitlements.priceMinor, entitlements.currency)}/mo`}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted">{PLAN_BLURB[planId]}</p>
                </div>
                <ul className="flex flex-col gap-1.5 text-sm text-foreground">
                  <li>{formatPlanLimit(entitlements.maxCustomers)} customers</li>
                  <li>{formatPlanLimit(entitlements.maxOpenInvoices)} open invoices</li>
                  <li>{formatPlanLimit(entitlements.maxMembers)} team members</li>
                  <li>{formatPlanLimit(entitlements.maxAiGenerationsPerMonth)} AI generations / month</li>
                  <li className={entitlements.collectionsAutomationEnabled ? undefined : "text-muted-foreground"}>
                    {entitlements.collectionsAutomationEnabled ? "Collections automation" : "No collections automation"}
                  </li>
                </ul>
                <Link href="/sign-up" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-2 self-start")}>
                  Get started
                </Link>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function TrustSection() {
  return (
    <section className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-6 sm:py-24">
      <p className="font-[family-name:var(--font-landing-mono)] text-xs font-medium tracking-wide text-primary uppercase">
        Security &amp; control
      </p>
      <h2 className="mt-3 max-w-xl font-[family-name:var(--font-landing-display)] text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
        Financial data deserves a serious security posture.
      </h2>
      <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
        {trustPoints.map((point, index) => (
          <div
            key={point.title}
            className="reveal-on-scroll flex flex-col gap-3"
            style={{ animationDelay: `${index * 60}ms` }}
          >
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
    <section className="relative overflow-hidden bg-navy-950">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_100%,rgba(106,99,224,0.22),transparent)]"
      />
      <div className="relative mx-auto flex w-full max-w-6xl flex-col items-center gap-6 px-5 py-20 text-center sm:px-6 sm:py-24">
        <h2 className="max-w-xl font-[family-name:var(--font-landing-display)] text-3xl font-medium tracking-tight text-white">
          Take control of your receivables.
        </h2>
        <p className="max-w-md text-sm leading-6 text-navy-muted">
          Create an account and see your outstanding invoices in one place — no credit
          card required.
        </p>
        <Link href="/sign-up" className={cn(buttonVariants({ variant: "premium", size: "lg" }))}>
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
        <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs">
          <Link href="/privacy-policy" className="hover:text-foreground">
            Privacy Policy
          </Link>
          <Link href="/terms-of-service" className="hover:text-foreground">
            Terms of Service
          </Link>
          <Link href="/data-retention" className="hover:text-foreground">
            Data Retention
          </Link>
          <Link href="/subprocessors" className="hover:text-foreground">
            Subprocessors
          </Link>
        </nav>
        <p>© {new Date().getFullYear()} PAYNORA. All rights reserved.</p>
      </div>
    </footer>
  );
}
