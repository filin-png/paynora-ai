import type { Metadata } from "next";

import { LegalPageShell } from "@/components/legal/legal-page-shell";
import { renderLegalDocHtml } from "@/lib/legal-docs";

export const metadata: Metadata = { title: "Subprocessors — PAYNORA" };

export default async function SubprocessorsPage() {
  const html = await renderLegalDocHtml("subprocessors");
  return (
    <LegalPageShell activeHref="/subprocessors">
      {/* Trusted, build-time-fixed local file (docs/subprocessors.md), never user input; see src/lib/legal-docs.ts */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </LegalPageShell>
  );
}
