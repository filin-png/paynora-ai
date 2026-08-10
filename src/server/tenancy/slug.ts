const RANDOM_SUFFIX_ATTEMPTS = 5;

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Appends a short random suffix on collision rather than failing outright —
 * organization names collide often ("Acme", "Acme Inc") and the slug is an
 * internal identifier, not a brand the org picks.
 */
export async function generateUniqueOrganizationSlug(
  name: string,
  slugExists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const base = slugify(name) || "organization";

  if (!(await slugExists(base))) return base;

  for (let attempt = 0; attempt < RANDOM_SUFFIX_ATTEMPTS; attempt++) {
    const candidate = `${base}-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await slugExists(candidate))) return candidate;
  }

  throw new Error("Could not generate a unique organization slug");
}
