import { Client } from "pg";

export function hasStage4aAdminTestConfiguration(): boolean {
  return process.env.STAGE4A_TEST_ADMIN_DATABASE_URL !== undefined
    || process.env.STAGE4A_TEST_DATABASE_SYSTEM_IDENTIFIER !== undefined;
}

/** Delete one synthetic fixture through the real administrative path, including commit-time FKs. */
export async function deleteStage4aTestOrganization(organizationId: string): Promise<void> {
  const raw = process.env.STAGE4A_TEST_ADMIN_DATABASE_URL;
  const systemIdentifier = process.env.STAGE4A_TEST_DATABASE_SYSTEM_IDENTIFIER;
  const invalidTarget = "Stage 4A requires the explicit isolated admin test database and system identifier";
  let url: URL;
  try {
    url = new URL(raw ?? "");
  } catch {
    throw new Error(invalidTarget);
  }
  if (
    process.env.NODE_ENV !== "test" || process.env.VITEST !== "true"
    || !systemIdentifier || !/^\d+$/u.test(systemIdentifier)
    || url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "55432"
    || url.pathname !== "/paynora_test" || url.username !== "paynora_test_admin" || !url.password
    || url.search !== "?schema=public" || url.hash
  ) {
    throw new Error(invalidTarget);
  }

  const client = new Client({
    connectionString: url.href,
    connectionTimeoutMillis: 2500,
    statement_timeout: 5000,
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    const { rows: [identity] } = await client.query<{ ok: boolean }>(`
      SELECT current_database() = 'paynora_test'
         AND session_user = 'paynora_test_admin' AND current_user = 'paynora_test_admin'
         AND inet_server_addr() = '127.0.0.1'::inet AND inet_server_port() = 55432
         AND current_schema() = 'public' AND current_setting('cluster_name', true) = 'paynora_test_isolated'
         AND current_setting('server_version_num')::int / 10000 = 17
         AND current_setting('transaction_read_only') = 'off'
         AND (SELECT system_identifier::text FROM pg_control_system()) = $1
         AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'paynora')
         AS ok
    `, [systemIdentifier]);
    if (identity?.ok !== true) throw new Error(invalidTarget);

    const { rowCount } = await client.query("DELETE FROM public.organizations WHERE id = $1", [organizationId]);
    if (rowCount !== 1) throw new Error("Expected to delete exactly one synthetic Stage 4A organization");
    await client.query("COMMIT");
  } finally {
    await client.end();
  }
}
