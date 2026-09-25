import type { Metadata } from "next";

import { LegalPageShell } from "@/components/legal/legal-page-shell";
import { renderLegalDocHtml } from "@/lib/legal-docs";

export const metadata: Metadata = { title: "Requisites — PAYNORA" };

export default async function RequisitesPage() {
  const html = await renderLegalDocHtml("requisites");
  return (
    <LegalPageShell activeHref="/requisites">
      {/* Trusted, build-time-fixed local file (docs/requisites.md), never user input; see src/lib/legal-docs.ts */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </LegalPageShell>
  );
}
