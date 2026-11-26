import { expect, it } from "vitest";

import { requireIsolatedTestDatabaseUrl } from "./test-database-target";

const validUrl = "postgresql://paynora_test_runner:test%40only@127.0.0.1:55432/paynora_test?schema=public";

it("accepts the exact isolated PostgreSQL target with an encoded password", () => {
  expect(requireIsolatedTestDatabaseUrl(validUrl)).toBe(validUrl);
});

it.each([
  { name: "missing", input: undefined },
  { name: "empty", input: "" },
  { name: "malformed", input: "not a URL" },
  { name: "scheme", input: validUrl.replace("postgresql:", "https:") },
  { name: "remote host", input: validUrl.replace("127.0.0.1", "db.example.invalid") },
  { name: "hostname alias", input: validUrl.replace("127.0.0.1", "localhost") },
  { name: "old port", input: validUrl.replace(":55432/", ":5432/") },
  { name: "development database", input: validUrl.replace("/paynora_test?", "/paynora?") },
  { name: "shared login", input: validUrl.replace("paynora_test_runner:", "paynora:") },
  { name: "missing password", input: validUrl.replace(":test%40only@", "@") },
  { name: "other schema", input: validUrl.replace("schema=public", "schema=private") },
  { name: "host override", input: validUrl + "&host=db.example.invalid" },
  { name: "duplicate schema", input: validUrl + "&schema=private" },
  { name: "connection options", input: validUrl + "&options=fixture" },
  { name: "fragment", input: validUrl + "#fragment" },
])("rejects $name without including the input in the error", ({ input }) => {
  expect(() => requireIsolatedTestDatabaseUrl(input)).toThrow(
    /^TEST_DATABASE_URL must point to the isolated PAYNORA test database$/,
  );
});
