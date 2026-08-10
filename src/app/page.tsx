import { Button } from "@/components/ui/button";

const capabilities = [
  {
    title: "Accounts receivable, tracked",
    description:
      "See every outstanding invoice, its status, and how overdue it is — in one place.",
  },
  {
    title: "Payment risk, surfaced early",
    description:
      "Know which receivables are at risk before they become write-offs.",
  },
  {
    title: "Collections, automated",
    description:
      "Contextual reminders and follow-up sequences, with a human in control.",
  },
];

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5">
          <span className="text-lg font-semibold tracking-tight">
            PAYNORA<span className="text-primary"> AI</span>
          </span>
          <span className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted">
            In development
          </span>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6">
        <section className="flex flex-col gap-6 py-20 sm:py-28">
          <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Stop chasing invoices manually.
          </h1>
          <p className="max-w-xl text-lg leading-8 text-muted">
            PAYNORA AI helps small B2B service businesses track accounts
            receivable, spot payment risk early, and automate collection
            follow-up — without replacing the accounting software you
            already use.
          </p>
          <div>
            <Button size="lg" disabled>
              Early access — coming soon
            </Button>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-6 border-t border-border py-16 sm:grid-cols-3">
          {capabilities.map((capability) => (
            <div key={capability.title} className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold">{capability.title}</h2>
              <p className="text-sm leading-6 text-muted">
                {capability.description}
              </p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto w-full max-w-5xl px-6 py-6 text-sm text-muted">
          © {new Date().getFullYear()} PAYNORA AI
        </div>
      </footer>
    </div>
  );
}
