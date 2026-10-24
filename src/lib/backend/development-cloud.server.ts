import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  ownerContext,
  rpc,
  BackendError,
  currentAccount,
  listFiles,
} from "./operations";
import { developmentCloudConfig } from "./development-cloud-config";
import { validateCheckpoint, recovery } from "../transfers/checkpoint";
import {
  canonical,
  parseManifest,
  type Manifest,
  type Block,
} from "../transfers/format";
import { digest } from "../transfers/codec";
import {
  preparationBinding,
  requireCloudPreparationProvenance,
} from "./cloud-preparation-provenance.server";
import { preparedCloudMetadata } from "../transfers/prepared-cloud";
import { restore } from "../transfers/restore";
import { ownedFile } from "./files";
import {
  postgresPublisher,
  publisherPool,
  postgresPublisherIdentityProbe,
} from "./development-publisher-postgres.server";
import { developmentUserVerifier } from "./development-user-verifier.server";

const uuid = z.uuid();
const sessionSchema = z.object({
  id: uuid,
  file_id: uuid,
  owner_id: uuid,
  state: z.string(),
  epoch: z.number().int().positive(),
  manifest_path: z.string(),
  initial_source_sha256: z.string(),
  lease_expires_at: z.string(),
});
const attemptSchema = z.object({
  id: uuid,
  owner_id: uuid,
  session_id: uuid,
  object_path: z.string(),
  epoch: z.number().int().positive(),
  state: z.string(),
  authorized_max_bytes: z.number().int().nonnegative(),
  acknowledged_bytes: z.number().int().nonnegative(),
  attempted_bytes: z.number().int().nonnegative(),
});
type Session = z.infer<typeof sessionSchema>;
type Attempt = z.infer<typeof attemptSchema>;
type Context = Awaited<ReturnType<typeof ownerContext>>;
function deny(code: string, status = 409): never {
  throw new BackendError(code, status);
}

/** Development only. Storage always uses the verified ordinary session/RLS.
 * Trusted RPC credentials are isolated, never used for Storage or table access. */
export class DevelopmentCloud {
  constructor(
    private readonly context: Context,
    private readonly config: NonNullable<
      ReturnType<typeof developmentCloudConfig>
    >,
    private readonly token: string,
    private readonly trusted: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>,
    private readonly http: typeof fetch = fetch,
    private readonly ensureTrusted: () => Promise<void> = async () => {},
  ) {}

  private permit(
    key: string,
    index: number,
    attempt: Attempt,
    block: Record<string, unknown>,
  ) {
    return createHmac("sha256", this.config.permitKey)
      .update(
        `${this.context.id}:${this.config.project}:${this.config.bucket}:${key}:${index}:${attempt.id}:${attempt.epoch}:${attempt.authorized_max_bytes}:${preparationBinding(block)}`,
      )
      .digest("hex");
  }

  private path(path: string, session?: Session) {
    const prefix = session
      ? `v1/${this.context.id}/${session.file_id}/${session.id}/${session.epoch}/`
      : `v1/${this.context.id}/`;
    if (
      !path.startsWith(prefix) ||
      path
        .split("/")
        .some((s) => !/^[a-zA-Z0-9_.-]+$/.test(s) || s === "." || s === "..")
    )
      deny("CLOUD_MEMBERSHIP_INVALID");
    return path.split("/").map(encodeURIComponent).join("/");
  }
  private async object(path: string, body?: Uint8Array<ArrayBuffer>) {
    const response = await this.http(
      `${this.config.url}/storage/v1/object/${this.config.bucket}/${this.path(path)}`,
      {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        cache: "no-store",
        headers: {
          apikey: this.config.key,
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/octet-stream",
          "x-upsert": "false",
        },
        body,
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      deny("CLOUD_OBJECT_REQUEST_FAILED", 503);
    }
    return response;
  }
  private async read(path: string, maximum: number) {
    const response = await this.object(path);
    if (!response.body) deny("CLOUD_DOWNLOAD_FAILED", 503);
    const reader = response.body.getReader();
    const bytes = new Uint8Array(maximum);
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (length + value.length > maximum) deny("CLOUD_OBJECT_SIZE_MISMATCH");
        bytes.set(value, length);
        length += value.length;
      }
      return bytes.slice(0, length);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  private async row(table: string, filters: Record<string, string | number>) {
    let query = this.context.client
      .from(table)
      .select("*")
      .eq("owner_id", this.context.id);
    for (const [key, value] of Object.entries(filters))
      query = query.eq(key, value);
    const result = await query.single();
    if (result.error || !result.data) deny("NOT_FOUND", 404);
    if (result.data.owner_id !== this.context.id) deny("NOT_FOUND", 404);
    return result.data;
  }
  private async session(key: string) {
    const session = sessionSchema.parse(
      await this.row("upload_sessions", { idempotency_key: uuid.parse(key) }),
    );
    if (session.owner_id !== this.context.id) deny("NOT_FOUND", 404);
    if (
      !["uploading", "reserved", "completed"].includes(session.state) ||
      (session.state !== "completed" &&
        (!Number.isFinite(Date.parse(session.lease_expires_at)) ||
          Date.parse(session.lease_expires_at) <= Date.now()))
    )
      deny("CLOUD_SESSION_BLOCKED");
    this.path(session.manifest_path, session);
    return session;
  }
  private async attempt(session: Session, index: number) {
    const block = await this.row("file_blocks", {
      session_id: session.id,
      block_index: index,
    });
    const attempt = attemptSchema.parse(
      await this.row("transfer_attempts", {
        block_id: block.id,
        session_id: session.id,
      }),
    );
    if (
      attempt.owner_id !== this.context.id ||
      attempt.session_id !== session.id ||
      attempt.epoch !== session.epoch
    )
      deny("CLOUD_MEMBERSHIP_INVALID");
    this.path(attempt.object_path, session);
    return attempt;
  }
  async begin(candidate: unknown) {
    const checkpoint = validateCheckpoint(candidate);
    if (checkpoint.ownerId !== this.context.id) deny("OWNER_FORBIDDEN", 403);
    if (
      !checkpoint.manifest ||
      !checkpoint.metadata ||
      checkpoint.originalBytes === 0 ||
      checkpoint.originalBytes > this.config.maximumBytes ||
      recovery(checkpoint).requiresRemoteReconciliation ||
      !["prepared", "acknowledged", "completed"].includes(checkpoint.phase)
    )
      deny("CLOUD_CHECKPOINT_BLOCKED");
    try {
      preparedCloudMetadata(checkpoint, this.context.id);
    } catch (error) {
      deny(
        error instanceof Error &&
          error.message === "CLOUD_COMPRESSED_FILE_REQUIRED"
          ? "CLOUD_COMPRESSED_FILE_REQUIRED"
          : "CLOUD_PREPARATION_UNVERIFIED",
      );
    }
    await this.ensureTrusted();
    await rpc(
      this.context,
      "ss_reserve",
      {
        p_key: checkpoint.id,
        p_name: checkpoint.metadata.originalName,
        p_mime: checkpoint.metadata.originalMime,
        p_original: checkpoint.originalBytes,
        p_hash: checkpoint.sourceSha256,
      },
      (value) => value,
    );
    const session = await this.session(checkpoint.id);
    if (session.initial_source_sha256 !== checkpoint.sourceSha256)
      deny("SOURCE_CHANGED");
    const permits: Record<number, string> = {};
    if (session.state !== "completed") {
      for (const block of checkpoint.manifest.blocks) {
        // Allocation remains authoritative. Never override storageAuthorityEnabled=false.
        if (
          ["completed", "acknowledged"].includes(
            checkpoint.blocks[block.index].phase,
          )
        ) {
          await this.verifiedBlock(session, block);
          continue;
        }
        const allocation = await rpc(
          this.context,
          "ss_allocate_attempt",
          {
            p_session: session.id,
            p_index: block.index,
            p_original: block.originalBytes,
            p_encoded: block.encodedBytes,
            p_codec: block.codec,
            p_original_hash: block.originalSha256,
            p_encoded_hash: block.encodedSha256,
          },
          (value) =>
            z.object({ storageAuthorityEnabled: z.boolean() }).parse(value),
        );
        if (!allocation.storageAuthorityEnabled)
          deny("CLOUD_STORAGE_AUTHORITY_DISABLED", 503);
        permits[block.index] = this.permit(
          checkpoint.id,
          block.index,
          await this.attempt(session, block.index),
          await this.row("file_blocks", {
            session_id: session.id,
            block_index: block.index,
          }),
        );
      }
    }
    return { fileId: session.file_id, permits };
  }
  async write(
    key: string,
    index: number,
    requestId: string,
    body: Uint8Array<ArrayBuffer>,
    permit: string,
  ) {
    if (body.length === 0 || body.length > this.config.maximumBytes)
      deny("BODY_LIMIT", 413);
    const session = await this.session(key),
      attempt = await this.attempt(session, index);
    const block = await this.row("file_blocks", {
      session_id: session.id,
      block_index: index,
    });
    if (
      !/^[a-f0-9]{64}$/.test(permit) ||
      !timingSafeEqual(
        Buffer.from(permit),
        Buffer.from(this.permit(key, index, attempt, block)),
      )
    )
      deny("CLOUD_STORAGE_AUTHORITY_DISABLED", 403);
    if (
      attempt.state !== "authorized" ||
      attempt.attempted_bytes !== 0 ||
      attempt.acknowledged_bytes !== 0 ||
      attempt.authorized_max_bytes !== body.length
    )
      deny("UPLOAD_RECOVERY_REQUIRED");
    await requireCloudPreparationProvenance(
      body,
      block,
      this.config.maximumBytes,
    );
    await this.trusted("ss_begin_attempt_request", {
      p_attempt: attempt.id,
      p_epoch: session.epoch,
      p_request: uuid.parse(requestId),
      p_body: body.length,
    });
    try {
      const response = await this.object(attempt.object_path, body);
      await response.body?.cancel();
      await this.trusted("ss_finish_attempt_request", {
        p_request: requestId,
        p_offset: body.length,
      });
    } catch (error) {
      await this.trusted("ss_finish_attempt_request", {
        p_request: requestId,
        p_offset: null,
      }).catch(() => {});
      throw error;
    }
    return { offset: body.length };
  }
  private async verifiedBlock(session: Session, block: Block) {
    const allocated = await this.row("file_blocks", {
      session_id: session.id,
      block_index: block.index,
    });
    if (
      allocated.codec !== block.codec ||
      allocated.original_offset !== block.offset ||
      allocated.original_bytes !== block.originalBytes ||
      allocated.encoded_bytes !== block.encodedBytes ||
      allocated.original_sha256 !== block.originalSha256 ||
      allocated.encoded_sha256 !== block.encodedSha256
    )
      deny("CLOUD_MEMBERSHIP_INVALID");
    const attempt: Attempt = await this.attempt(session, block.index);
    if (
      !["in_flight", "present"].includes(attempt.state) ||
      attempt.acknowledged_bytes !== block.encodedBytes
    )
      deny("UPLOAD_RECOVERY_REQUIRED");
    const bytes = await this.read(attempt.object_path, block.encodedBytes);
    if (
      bytes.length !== block.encodedBytes ||
      digest(bytes) !== block.encodedSha256
    )
      deny("ENCODED_INTEGRITY");
    return { attempt, bytes };
  }
  async verify(key: string, index: number) {
    const session = await this.session(key);
    const value = await this.row("file_blocks", {
      session_id: session.id,
      block_index: index,
    });
    const block: Block = {
      index,
      offset: value.original_offset,
      originalBytes: value.original_bytes,
      encodedBytes: value.encoded_bytes,
      codec: value.codec,
      originalSha256: value.original_sha256,
      encodedSha256: value.encoded_sha256,
    };
    const { bytes } = await this.verifiedBlock(session, block);
    return { encodedBytes: bytes.length, encodedSha256: digest(bytes) };
  }
  async publish(key: string, candidate: unknown) {
    await this.ensureTrusted();
    const manifest = parseManifest(candidate);
    if (manifest.originalBytes > this.config.maximumBytes)
      deny("BODY_LIMIT", 413);
    const session = await this.session(key);
    if (manifest.originalSha256 !== session.initial_source_sha256)
      deny("SOURCE_CHANGED");
    const encoded = new TextEncoder().encode(canonical(manifest));
    const manifestSha256 = digest(encoded);
    // Independently restore provider bytes before trusting any client proof.
    await restore(
      manifest,
      {
        open: async (block) => {
          const { attempt, bytes } = await this.verifiedBlock(session, block);
          if (session.state !== "completed")
            await this.trusted("ss_record_observation", {
              p_attempt: attempt.id,
              p_epoch: session.epoch,
              p_size: bytes.length,
            });
          return { index: block.index, stream: new Blob([bytes]).stream() };
        },
      },
      { write: async () => {}, commit: async () => {}, abort: async () => {} },
    );
    if (session.state !== "completed") {
      const response = await this.object(session.manifest_path, encoded);
      await response.body?.cancel();
    }
    const observed = await this.read(session.manifest_path, encoded.length);
    if (
      observed.length !== encoded.length ||
      digest(observed) !== manifestSha256
    )
      deny("MANIFEST_INTEGRITY");
    const file = ownedFile.parse(
      await this.trusted("ss_finalize_verified", {
        p_session: session.id,
        p_manifest: manifest,
        p_size: encoded.length,
        p_sha256: manifestSha256,
        p_path: session.manifest_path,
      }),
    );
    if (file.id !== session.file_id || file.state !== "ready")
      deny("PUBLICATION_NOT_VERIFIED");
    return {
      published: true,
      manifestSha256,
      originalSha256: manifest.originalSha256,
    };
  }
  async ready(fileId: string): Promise<Manifest> {
    const file = await this.row("files", {
      id: uuid.parse(fileId),
      state: "ready",
    });
    const record = await this.row("file_manifests", { file_id: fileId });
    if (
      record.object_path !== file.manifest_path ||
      record.sha256 !== file.manifest_sha256
    )
      deny("MANIFEST_INTEGRITY");
    const manifest = parseManifest(record.manifest);
    if (
      manifest.originalBytes > this.config.maximumBytes ||
      manifest.originalSha256 !== file.source_sha256
    )
      deny("MANIFEST_INTEGRITY");
    const bytes = await this.read(record.object_path, 131072);
    if (
      digest(bytes) !== record.sha256 ||
      canonical(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      ) !== canonical(manifest)
    )
      deny("MANIFEST_INTEGRITY");
    return manifest;
  }
  async download(fileId: string, index: number) {
    const manifest = await this.ready(fileId),
      block = manifest.blocks[index];
    if (!block) deny("NOT_FOUND", 404);
    const record = await this.row("file_manifests", { file_id: fileId });
    const session = sessionSchema.parse(
      await this.row("upload_sessions", {
        id: record.session_id,
        file_id: fileId,
      }),
    );
    if (session.state !== "completed") deny("NOT_FOUND", 404);
    return (await this.verifiedBlock(session, block)).bytes;
  }
  async receipt(key: string, expectedOwner = this.context.id) {
    if (expectedOwner !== this.context.id) deny("OWNER_FORBIDDEN", 403);
    const session = await this.session(key);
    if (session.state !== "completed") deny("CLOUD_RECONCILIATION_REQUIRED");
    const record = await this.row("file_manifests", {
      file_id: session.file_id,
      session_id: session.id,
    });
    if (record.object_path !== session.manifest_path)
      deny("MANIFEST_INTEGRITY");
    const manifest = await this.ready(session.file_id);
    if (manifest.originalSha256 !== session.initial_source_sha256)
      deny("MANIFEST_INTEGRITY");
    return {
      fileId: session.file_id,
      manifestSha256: digest(new TextEncoder().encode(canonical(manifest))),
      originalSha256: manifest.originalSha256,
      published: true as const,
    };
  }
  async listing() {
    const [listing, account] = await Promise.all([
      listFiles(this.context),
      currentAccount(this.context),
    ]);
    return {
      files: listing.files.map((file) => ({ ...file, sessionId: file.id })),
      account,
    };
  }
}

export async function verifyDevelopmentCloudSession(
  context: Context,
  config: NonNullable<ReturnType<typeof developmentCloudConfig>>,
) {
  const { data, error } = await context.client.auth.getSession();
  const token = data.session?.access_token;
  if (error || !token) deny("UNAUTHENTICATED", 401);
  // Claims are accepted only after signature verification by this project's SDK.
  const claims = await context.client.auth.getClaims(token);
  if (
    claims.error ||
    claims.data?.claims.iss !== `${config.url}/auth/v1` ||
    claims.data.claims.sub !== context.id ||
    claims.data.claims.role !== "authenticated" ||
    !Number.isFinite(claims.data.claims.exp) ||
    claims.data.claims.exp <= Date.now() / 1000
  )
    deny("CLOUD_PROJECT_ACCOUNT_MISMATCH", 403);
  const { data: bucket, error: bucketError } =
    await context.client.storage.getBucket(config.bucket);
  if (
    bucketError ||
    !bucket ||
    bucket.id !== config.bucket ||
    bucket.public !== false ||
    !Number.isSafeInteger(Number(bucket.file_size_limit)) ||
    Number(bucket.file_size_limit) < 131072 ||
    !bucket.allowed_mime_types?.includes("application/octet-stream")
  )
    deny("CLOUD_PRIVATE_BUCKET_UNVERIFIED", 503);
  return token;
}

export async function developmentCloudRuntime() {
  const config = developmentCloudConfig(process.env);
  if (!config) deny("DEV_CLOUD_DISABLED", 503);
  const context = await ownerContext();
  const token = await verifyDevelopmentCloudSession(context, config);
  const selection = process.env.SMART_STORAGE_DEV_CLOUD_PUBLISHER;
  if (selection && selection !== "jwt" && selection !== "postgres")
    deny("CLOUD_TRUSTED_RPC_UNAVAILABLE", 503);
  const { trusted, ensureTrusted } =
    selection === "postgres"
      ? await developmentCloudPostgresAuthority(
          context,
          config,
          process.env.SMART_STORAGE_DEV_CLOUD_POSTGRES_URL ?? "",
        )
      : developmentCloudAuthority(context, config);
  return new DevelopmentCloud(
    context,
    config,
    token,
    trusted,
    fetch,
    ensureTrusted,
  );
}

export function developmentCloudAuthority(
  context: Context,
  config: NonNullable<ReturnType<typeof developmentCloudConfig>>,
  env: Record<string, string | undefined> = process.env,
  http: typeof fetch = fetch,
) {
  const workerToken = env.SMART_STORAGE_DEV_CLOUD_RPC_TOKEN ?? "";
  const workerRole = env.SMART_STORAGE_DEV_CLOUD_RPC_ROLE ?? "";
  const ensureTrusted = async () => {
    // Reject general administrative and ordinary-user authority. This adapter may
    // call existing trusted RPCs only with a separately provisioned restricted role.
    if (!/^ss_[a-z0-9_]{1,48}$/.test(workerRole) || !workerToken)
      deny("CLOUD_TRUSTED_RPC_UNAVAILABLE", 503);
    const result = await context.client.auth.getClaims(workerToken);
    const claims = result.data?.claims;
    if (
      result.error ||
      !claims ||
      claims.iss !== `${config.url}/auth/v1` ||
      claims.role !== workerRole ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= Date.now() / 1000
    )
      deny("CLOUD_TRUSTED_RPC_UNAVAILABLE", 503);
  };
  const trusted = async (name: string, args: Record<string, unknown>) => {
    await ensureTrusted();
    if (
      ![
        "ss_begin_attempt_request",
        "ss_finish_attempt_request",
        "ss_record_observation",
        "ss_finalize_verified",
      ].includes(name)
    )
      deny("CLOUD_TRUSTED_RPC_UNAVAILABLE", 503);
    const response = await http(`${config.url}/rest/v1/rpc/${name}`, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${workerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!response.ok) {
      await response.body?.cancel();
      deny("CLOUD_TRUSTED_RPC_UNAVAILABLE", 503);
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const body = new Uint8Array(16384);
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (length + value.length > body.length)
          deny("CLOUD_TRUSTED_RPC_UNAVAILABLE", 503);
        body.set(value, length);
        length += value.length;
      }
      return length
        ? JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              body.subarray(0, length),
            ),
          )
        : null;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
  return { trusted, ensureTrusted };
}

/** Explicit development opt-in only; no fallback to another authority on failure. */
export async function developmentCloudPostgresAuthority(
  context: Context,
  config: NonNullable<ReturnType<typeof developmentCloudConfig>>,
  connection: string,
) {
  try {
    if (
      process.env.NODE_ENV === "production" ||
      config.environment !== "development" ||
      config.project !== "fneuqneqaopkmpeevlqz"
    )
      throw Error();
    const identity = await developmentUserVerifier(context.client.auth);
    if (identity.id !== context.id) throw Error();
    const db = publisherPool(connection);
    const authority = postgresPublisher(db, identity.verify);
    const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } catch {
        deny("CLOUD_TRUSTED_RPC_UNAVAILABLE", 503);
      }
    };
    return {
      trusted: (name: string, args: Record<string, unknown>) =>
        guarded(() => authority.trusted(name, args)),
      ensureTrusted: () =>
        guarded(async () => {
          await identity.verify();
          // Bind both probe checks to this runtime's original verified owner.
          await postgresPublisherIdentityProbe(db, {
            getSession: context.client.auth.getSession.bind(
              context.client.auth,
            ),
            getUser: async (token) => {
              const result = await context.client.auth.getUser(token);
              if (result.data.user?.id !== identity.id) throw Error();
              return result;
            },
            getClaims: context.client.auth.getClaims.bind(context.client.auth),
          });
        }),
    };
  } catch {
    deny("CLOUD_TRUSTED_RPC_UNAVAILABLE", 503);
  }
}
