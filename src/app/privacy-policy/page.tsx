import type { Metadata } from "next";

import { LegalPageShell } from "@/components/legal/legal-page-shell";
import { renderLegalDocHtml } from "@/lib/legal-docs";

export const metadata: Metadata = { title: "Privacy Policy — PAYNORA" };

export default async function PrivacyPolicyPage() {
  const html = await renderLegalDocHtml("privacy-policy");
  return (
    <LegalPageShell activeHref="/privacy-policy">
      {/* Trusted, build-time-fixed local file (docs/privacy-policy.md), never user input; see src/lib/legal-docs.ts */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </LegalPageShell>
  );
}
