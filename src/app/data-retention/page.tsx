import type { Metadata } from "next";

import { LegalPageShell } from "@/components/legal/legal-page-shell";
import { renderLegalDocHtml } from "@/lib/legal-docs";

export const metadata: Metadata = { title: "Data Retention — PAYNORA" };

export default async function DataRetentionPage() {
  const html = await renderLegalDocHtml("data-retention");
  return (
    <LegalPageShell activeHref="/data-retention">
      {/* Trusted, build-time-fixed local file (docs/data-retention.md), never user input; see src/lib/legal-docs.ts */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </LegalPageShell>
  );
}
