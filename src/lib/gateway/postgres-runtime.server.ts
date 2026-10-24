import "server-only";

/** A dedicated restricted-login pool. Implementations must discard a connection
 * when release receives an error; query must use PostgreSQL bind parameters. */
export interface GatewayPostgresClient {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  release(error?: Error): void;
}
export interface GatewayPostgresPool {
  connect(): Promise<GatewayPostgresClient>;
}

export async function executorTransaction<T>(
  pool: GatewayPostgresPool,
  work: (client: GatewayPostgresClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let failed: Error | undefined;
  try {
    await client.query("BEGIN");
    const identity =
      await client.query(`SELECT session_user = 'ss_gateway_runtime_test'
      AND current_user = session_user
      AND current_database() = 'smart_storage_gateway_test'
      AND inet_server_addr() = '127.0.0.1'::inet
      AND inet_server_port() = 5432
      AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)
      AS allowed FROM pg_catalog.pg_roles WHERE rolname = session_user`);
    if (identity.rows.length !== 1 || identity.rows[0].allowed !== true)
      throw new Error("RESTRICTED_RUNTIME_REQUIRED");
    await client.query("SET LOCAL ROLE ss_gateway_executor");
    const result = await work(client);
    // A lost COMMIT acknowledgment must reject; never retry dispatch here.
    await client.query("COMMIT");
    return result;
  } catch (error) {
    failed = new Error("GATEWAY_DATABASE_FAILURE");
    try {
      await client.query("ROLLBACK");
    } catch {
      // Connection is discarded below, including uncertain COMMIT outcomes.
    }
    throw error;
  } finally {
    client.release(failed);
  }
}
