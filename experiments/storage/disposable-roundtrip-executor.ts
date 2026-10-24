import { open } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { request as httpsRequest } from "node:https";
import { z } from "zod";
import { digest, encodeBlock, transform } from "../../src/lib/transfers/codec";
import {
  disposableUploadAttemptGate,
  disposableUploadTarget as target,
  MAX_TEST_BYTES,
  preflightDisposableUpload,
} from "./disposable-upload-contract";

export async function prepareDisposableFixture() {
  const source = new TextEncoder().encode(
    "Disposable Smart Storage round trip.\n".repeat(128),
  );
  const encoded = await encodeBlock(source);
  if (encoded.codec !== "gzip") throw Error("GZIP_REQUIRED");
  return {
    source,
    encoded: encoded.bytes,
    sourceBytes: source.length,
    encodedBytes: encoded.bytes.length,
    sourceSha256: digest(source),
    encodedSha256: digest(encoded.bytes),
  };
}

/** Use one operator-reviewed, persistent directory for every invocation. Never
 * remove claims. Exclusive creation consumes even empty/interrupted records.
 * Process restart fencing only; filesystem/ACL and power-loss qualification
 * remain prerequisites for a live host. No directory is created implicitly. */
export function filesystemAttemptClaims(directory: string) {
  if (!directory || resolve(directory) !== directory)
    throw Error("ABSOLUTE_CLAIM_DIRECTORY_REQUIRED");
  return async (key: string) => {
    const name = digest(new TextEncoder().encode(key));
    let file;
    try {
      file = await open(join(directory, `${name}.claim`), "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try {
      await file.writeFile("consumed-before-dispatch\n");
      await file.sync();
    } finally {
      await file.close();
    }
    return true;
  };
}

const sessionSchema = z
  .object({
    source: z.literal("external-verified-ordinary-session"),
    userId: z.literal(target.userId),
    issuer: z.literal("https://rrylhvqalsxjnkdkpwde.supabase.co/auth/v1"),
    role: z.literal("authenticated"),
    accessToken: z
      .string()
      .min(1)
      .max(16384)
      .regex(/^[A-Za-z0-9._-]+$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();
const authorizationSchema = z
  .object({
    project: z.literal(target.project),
    bucket: z.literal(target.bucket),
    key: z.literal(target.key),
    upload: z.literal(1),
    download: z.literal(1),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type VerifiedDisposableSession = z.infer<typeof sessionSchema>;
export interface DisposableProvider {
  create(
    bytes: Uint8Array<ArrayBuffer>,
    session: VerifiedDisposableSession,
  ): Promise<void>;
  download(
    session: VerifiedDisposableSession,
  ): Promise<Uint8Array<ArrayBuffer>>;
}

/** No SDK, environment, redirects, retries, deletion or general-purpose URL.
 * Native HTTPS must be supplied explicitly by a separately reviewed host.
 * Counts accepted response-body bytes, not physical TLS/network traffic. */
export function disposableSupabaseAdapter(
  request: typeof httpsRequest,
): DisposableProvider {
  function exchange(
    method: "POST" | "GET",
    session: VerifiedDisposableSession,
    body?: Uint8Array<ArrayBuffer>,
  ): Promise<Uint8Array<ArrayBuffer>> {
    sessionSchema.parse(session);
    const path = `${method === "GET" ? "object/authenticated" : "object"}/${target.bucket}/${target.key}`;
    return new Promise((accept, reject) => {
      let settled = false;
      const finish = (error?: Error, bytes?: Uint8Array<ArrayBuffer>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else accept(bytes!);
      };
      const req = request(
        `${target.endpoint}/${path}`,
        {
          method,
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            "accept-encoding": "identity",
            ...(body
              ? {
                  "content-type": "application/octet-stream",
                  "content-length": String(body.length),
                  "x-upsert": "false",
                }
              : {}),
          },
        },
        (res) => {
          const out = new Uint8Array(MAX_TEST_BYTES);
          let length = 0;
          const fail = () => {
            finish(Error("PROVIDER_RESPONSE_UNCERTAIN"));
            res.destroy();
            req.destroy();
          };
          if (
            (res.statusCode ?? 0) < 200 ||
            (res.statusCode ?? 0) >= 300 ||
            (res.headers["content-encoding"] &&
              res.headers["content-encoding"] !== "identity")
          ) {
            fail();
            return;
          }
          res.on("data", (chunk: Buffer) => {
            if (settled) return;
            if (length + chunk.length > MAX_TEST_BYTES) {
              fail();
              return;
            }
            out.set(chunk, length);
            length += chunk.length;
          });
          res.on("error", fail);
          res.on("aborted", fail);
          res.on("close", () => {
            if (!res.complete) fail();
          });
          res.on("end", () => {
            if (!res.complete) fail();
            else finish(undefined, out.slice(0, length));
          });
        },
      );
      const timer = setTimeout(() => {
        finish(Error("PROVIDER_TIMEOUT_UNCERTAIN"));
        req.destroy();
      }, 30_000);
      req.on("error", () => finish(Error("PROVIDER_REQUEST_UNCERTAIN")));
      req.end(body);
    });
  }
  return {
    async create(bytes, session) {
      if (!bytes.length || bytes.length > MAX_TEST_BYTES)
        throw Error("UPLOAD_LIMIT");
      await exchange("POST", session, bytes);
    },
    download: (session) => exchange("GET", session),
  };
}

export async function executeDisposableRoundTrip(input: {
  config: unknown;
  source: Uint8Array<ArrayBuffer>;
  encoded: Uint8Array<ArrayBuffer>;
  authorization: unknown;
  session: () => Promise<unknown>;
  claimOnce: (key: string) => Promise<boolean>;
  provider: DisposableProvider;
  now?: () => number;
}) {
  const source = input.source.slice(),
    encoded = input.encoded.slice();
  const config = await preflightDisposableUpload(input.config, source, encoded);
  const authorization = authorizationSchema.parse(input.authorization);
  const now = input.now ?? Date.now;
  const check = (session?: VerifiedDisposableSession) => {
    if (
      authorization.expiresAt <= now() ||
      (session && session.expiresAt <= now())
    )
      throw Error("AUTHORIZATION_OR_SESSION_EXPIRED");
  };
  check();
  const session = sessionSchema.parse(await input.session());
  const gate = disposableUploadAttemptGate(input.claimOnce);
  check(session);
  await gate("upload");
  check(session);
  await input.provider.create(encoded.slice(), session);
  check(session);
  await gate("download");
  check(session);
  const downloaded = await input.provider.download(session);
  if (
    downloaded.length !== config.encodedBytes ||
    digest(downloaded) !== config.encodedSha256
  )
    throw Error("DOWNLOADED_ENCODED_INTEGRITY");
  const restored = await transform(downloaded, "decode", config.sourceBytes);
  if (
    restored.length !== source.length ||
    digest(restored) !== config.sourceSha256 ||
    !restored.every((value, index) => value === source[index])
  )
    throw Error("RESTORED_INTEGRITY");
  return {
    verified: true as const,
    sourceBytes: source.length,
    encodedBytes: encoded.length,
  };
}
