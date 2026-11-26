export function requireIsolatedTestDatabaseUrl(raw: string | undefined): string {
  let url: URL | undefined;
  try {
    if (raw) url = new URL(raw);
  } catch {
    // Use the same error for missing and malformed URLs to avoid exposing credentials.
  }

  if (
    !url ||
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "55432" ||
    url.pathname !== "/paynora_test" ||
    url.username !== "paynora_test_runner" ||
    !url.password ||
    url.search !== "?schema=public" ||
    url.hash
  ) {
    throw new Error("TEST_DATABASE_URL must point to the isolated PAYNORA test database");
  }

  return url.href;
}
