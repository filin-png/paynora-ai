import { readFile } from "node:fs/promises";
import path from "node:path";

import { marked } from "marked";

/**
 * Renders one of the docs/*.md legal foundation documents (Phase 15A) as
 * HTML for a public page — see src/app/privacy-policy/page.tsx and
 * siblings. `docs/` stays the single source of truth: these pages never
 * hold a second copy of the text, so the two can never drift apart the
 * way docs/privacy-policy.md's own preamble warns other doc pairs can.
 *
 * The source is always one of a fixed, hardcoded set of local repository
 * files (see LEGAL_DOC_SLUGS below) — never a path derived from a
 * request, so there is no path-traversal surface here despite the
 * `readFile` call.
 */
export const LEGAL_DOC_SLUGS = ["privacy-policy", "terms-of-service", "data-retention", "subprocessors"] as const;
export type LegalDocSlug = (typeof LEGAL_DOC_SLUGS)[number];

export async function renderLegalDocHtml(slug: LegalDocSlug): Promise<string> {
  const filePath = path.join(process.cwd(), "docs", `${slug}.md`);
  const source = await readFile(filePath, "utf-8");
  return marked.parse(source, { async: false });
}
