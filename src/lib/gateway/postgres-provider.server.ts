import "server-only";
import {
  PostgresAuthority,
  type TrustedGatewayIdentity,
} from "./postgres-authority.server";
import { PostgresEvidence } from "./postgres-evidence.server";
import type { GatewayPostgresPool } from "./postgres-runtime.server";
import type { StorageTransport } from "./provider-contracts";
import { SupabaseStorageProvider } from "./supabase-storage-provider.server";
import {
  SupabaseStorageTransport,
  type TransportDependencies,
} from "./supabase-storage-transport.server";

/** Internal server-only composition; never imported by routes or client code. */
export function createPostgresStorageProvider(
  pool: GatewayPostgresPool,
  identity: TrustedGatewayIdentity,
  transport: StorageTransport,
  limits?: { timeoutMs: number; maximumChunkBytes: number },
) {
  return new SupabaseStorageProvider(
    transport,
    new PostgresAuthority(pool, identity),
    new PostgresEvidence(pool, identity),
    limits,
  );
}

/** Disabled by default, explicit dependencies only; no credential/environment reads. */
export function createConcretePostgresStorageProvider(
  pool: GatewayPostgresPool,
  identity: TrustedGatewayIdentity,
  dependencies: TransportDependencies,
) {
  const transport = new SupabaseStorageTransport(dependencies);
  return {
    provider: createPostgresStorageProvider(pool, identity, transport),
    transport,
  };
}
