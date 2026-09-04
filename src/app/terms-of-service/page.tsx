import type { Metadata } from "next";

import { LegalPageShell } from "@/components/legal/legal-page-shell";
import { renderLegalDocHtml } from "@/lib/legal-docs";

export const metadata: Metadata = { title: "Terms of Service — PAYNORA" };

export default async function TermsOfServicePage() {
  const html = await renderLegalDocHtml("terms-of-service");
  return (
    <LegalPageShell activeHref="/terms-of-service">
      {/* Trusted, build-time-fixed local file (docs/terms-of-service.md), never user input; see src/lib/legal-docs.ts */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </LegalPageShell>
  );
}
