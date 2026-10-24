import "server-only";
import { createHash } from "node:crypto";
import type {
  DispatchPermit,
  StorageTransport,
  WriteIntent,
} from "./provider-contracts";
import { intentSchema, permitSchema } from "./supabase-storage-provider.server";
import {
  seededFixtureSchema,
  type SeededFixture,
} from "./seeded-fixture-contract";

export type HttpFetch = (
  url: string,
  init: RequestInit & { duplex?: "half" },
) => Promise<Response>;
export class InspectionFailure extends Error {
  constructor(
    readonly status: number,
    readonly responseBytes: number,
    reason = "INSPECTION_INCOMPLETE",
  ) {
    super(reason);
  }
}
export type TransportHint = Readonly<{
  classification: "provisional";
  state: "dispatch" | "response" | "unknown";
  forwardedBytes: number;
  status: number | null;
  requestId: string | null;
  version: string | null;
  etag: string | null;
  errorCode: string | null;
  reason: string;
  retainHolds: true;
  certified: false;
  futureProviderEffectsPossible: true;
  dispatchRequestId: string;
  resourceId: string;
  epoch: number;
  dispatchGeneration: number;
  objectId: string | null;
}>;
export type TransportDependencies = Readonly<{
  endpoint: string;
  bucket: string;
  prefix: string;
  maximumEncodedBytes: number;
  timeoutMs: number;
  enabled?: boolean;
  credentials: () => Promise<Readonly<{ bearer: string; apiKey: string }>>;
  fetch: HttpFetch;
  report: (hint: TransportHint) => Promise<void>;
  /** Trusted deployment qualification, NOT a caller assertion or certificate.
   * Must cover temporary/final/retained bytes, including possible late effects.
   * null means unknown and prevents dispatch before credentials/HTTP. */
  exposureBound: (permit: DispatchPermit) => number | null;
  inspectResponse?: (
    headers: Headers,
  ) => Readonly<{ errorCode: string | null }>;
}>;

const bounded = (v: string | null) =>
  v !== null && /^[\x20-\x7e]{1,256}$/.test(v) ? v : null;
const count = (v: number) => Number.isSafeInteger(v) && v >= 0;
const errorCode = (v: unknown) =>
  typeof v === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v) ? v : null;
function segments(value: string) {
  const parts = value.split("/");
  if (
    parts.some(
      (p) => !p || p === "." || p === ".." || /[\\%\x00-\x20?#]/.test(p),
    )
  )
    throw Error("INVALID_SCOPE");
  return parts.map(encodeURIComponent).join("/");
}

async function deadline<T>(
  ms: number,
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    controller.abort();
    rejectAbort(Error("INSPECTION_UNKNOWN"));
  };
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, ms);
  try {
    if (signal.aborted) throw Error("INSPECTION_UNKNOWN");
    return await Promise.race([work(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal.removeEventListener("abort", abort);
  }
}

async function responseJson(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 16384) throw Error("RESPONSE_LIMIT");
      chunks.push(next.value);
    }
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

/** Internal candidate. No global fetch/env/SDK fallback and no certificate APIs. */
export class SupabaseStorageTransport implements StorageTransport {
  private readonly deps: TransportDependencies;
  private readonly endpoint: string;
  // Additional instance-local misuse fence only; PostgreSQL remains replay authority.
  private readonly used = new WeakSet<DispatchPermit>();
  constructor(deps: TransportDependencies) {
    this.deps = Object.freeze({ ...deps });
    const url = new URL(deps.endpoint);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/storage/v1"
    )
      throw Error("INVALID_ENDPOINT");
    if (
      !count(deps.maximumEncodedBytes) ||
      !count(deps.timeoutMs) ||
      deps.timeoutMs < 1 ||
      deps.timeoutMs > 2147483647
    )
      throw Error("INVALID_LIMITS");
    if (deps.bucket.includes("/")) throw Error("INVALID_SCOPE");
    segments(deps.bucket);
    segments(deps.prefix);
    this.endpoint = url.href;
  }
  assertSupported(operation: string) {
    if (!this.deps.enabled) throw Error("TRANSPORT_DISABLED");
    if (operation !== "single-object-create")
      throw Error("UNSUPPORTED_CAPABILITY");
  }
  private scope(intent: WriteIntent | SeededFixture) {
    if (intent.operation === "seeded-fixture-inspection")
      seededFixtureSchema.parse(intent);
    else intentSchema.parse(intent);
    if (
      intent.bucket !== this.deps.bucket ||
      !intent.path.startsWith(this.deps.prefix + "/")
    )
      throw Error("SCOPE_MISMATCH");
    return `${segments(intent.bucket)}/${segments(intent.path)}`;
  }
  private async headers() {
    const secret = await this.deps.credentials();
    if (
      !secret.bearer ||
      !secret.apiKey ||
      /[\r\n]/.test(secret.bearer + secret.apiKey)
    )
      throw Error("INVALID_CREDENTIAL");
    return { Authorization: `Bearer ${secret.bearer}`, apikey: secret.apiKey };
  }
  async create(input: Parameters<StorageTransport["create"]>[0]) {
    this.assertSupported(input.intent.operation);
    const intent = Object.freeze({ ...intentSchema.parse(input.intent) });
    const path = this.scope(intent);
    const permit = permitSchema.parse(input.permit);
    if (
      Object.keys(intent).some(
        (k) =>
          intent[k as keyof WriteIntent] !==
          permit.intent[k as keyof WriteIntent],
      ) ||
      intent.declaredBytes > permit.maximumEncodedBytes ||
      permit.maximumEncodedBytes > this.deps.maximumEncodedBytes ||
      permit.reservedExposureBytes < permit.maximumEncodedBytes ||
      (!permit.allowZeroBytes && !intent.declaredBytes)
    )
      throw Error("INVALID_PERMIT");
    const options = input.options;
    if (
      options.redirect !== "error" ||
      options.retries !== 0 ||
      options.upsert !== false ||
      options.contentType !== "application/octet-stream" ||
      options.contentLength !== intent.declaredBytes
    )
      throw Error("UNSUPPORTED_OPTIONS");
    const bound = this.deps.exposureBound(permit);
    if (
      bound === null ||
      !count(bound) ||
      bound < intent.declaredBytes ||
      bound > permit.reservedExposureBytes
    )
      throw Error("EXPOSURE_UNVERIFIED");
    if (this.used.has(input.permit)) throw Error("DUPLICATE_DISPATCH");
    this.used.add(input.permit);
    const controller = new AbortController();
    let forwarded = 0,
      complete = false,
      failure = "LOST_RESPONSE";
    const hash = createHash("sha256");
    const iterator = input.body[Symbol.asyncIterator]();
    let stream: ReadableStream<Uint8Array> | undefined;
    const hint = (
      state: TransportHint["state"],
      reason: string,
      response?: Response,
    ): TransportHint => ({
      classification: "provisional",
      dispatchRequestId: intent.requestId,
      resourceId: intent.resourceId,
      epoch: intent.epoch,
      dispatchGeneration: intent.dispatchGeneration,
      objectId: null,
      state,
      reason,
      forwardedBytes: forwarded,
      status: response?.status ?? null,
      requestId: bounded(response?.headers.get("x-request-id") ?? null),
      version: bounded(response?.headers.get("x-version-id") ?? null),
      etag: bounded(response?.headers.get("etag") ?? null),
      errorCode: errorCode(
        response
          ? (this.deps.inspectResponse?.(response.headers).errorCode ??
              response.headers.get("x-error-code"))
          : null,
      ),
      retainHolds: true,
      certified: false,
      futureProviderEffectsPossible: true,
    });
    let rejectAbort: (error: Error) => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const abort = () => {
      controller.abort();
      rejectAbort(Error(failure));
    };
    const externalAbort = () => {
      failure = "CANCELLED_UNKNOWN";
      abort();
    };
    input.signal.addEventListener("abort", externalAbort, { once: true });
    if (input.signal.aborted) externalAbort();
    const timer = setTimeout(() => {
      failure = "TIMEOUT_UNKNOWN";
      abort();
    }, this.deps.timeoutMs);
    try {
      const work = async () => {
        const auth = await this.headers();
        if (controller.signal.aborted) throw Error(failure);
        await this.deps.report(hint("dispatch", "DISPATCH_INTENT"));
        if (controller.signal.aborted) throw Error(failure);
        stream = new ReadableStream<Uint8Array>(
          {
            pull: async (sink) => {
              try {
                const next = await iterator.next();
                if (controller.signal.aborted) throw Error(failure);
                if (next.done) {
                  if (forwarded !== intent.declaredBytes)
                    throw Error("TRUNCATED");
                  if (hash.digest("hex") !== intent.expectedSha256)
                    throw Error("HASH_MISMATCH");
                  complete = true;
                  sink.close();
                  return;
                }
                const chunk = next.value;
                if (!(chunk instanceof Uint8Array) || chunk.byteLength > 65536)
                  throw Error("INVALID_CHUNK");
                if (chunk.byteLength > intent.declaredBytes - forwarded)
                  throw Error("OVERSIZED");
                const copy = Uint8Array.from(chunk);
                hash.update(copy);
                forwarded += copy.byteLength;
                sink.enqueue(copy);
              } catch (error) {
                failure =
                  error instanceof Error &&
                  [
                    "TRUNCATED",
                    "HASH_MISMATCH",
                    "OVERSIZED",
                    "INVALID_CHUNK",
                  ].includes(error.message)
                    ? error.message
                    : "STREAM_UNKNOWN";
                sink.error(Error(failure));
                abort();
              }
            },
            cancel: () => {
              failure = "CANCELLED_UNKNOWN";
              abort();
            },
          },
          { highWaterMark: 0 },
        );
        const response = await this.deps.fetch(
          `${this.endpoint}/object/${path}`,
          {
            method: "POST",
            headers: {
              ...auth,
              "Content-Type": "application/octet-stream",
              "Content-Length": String(intent.declaredBytes),
              "x-upsert": "false",
            },
            body: stream,
            duplex: "half",
            redirect: "error",
            signal: controller.signal,
          },
        );
        // A misbehaving injected HTTP client must not make a redirect look accepted.
        if (
          response.redirected ||
          (response.status >= 300 && response.status < 400)
        )
          throw Error("REDIRECT_REJECTED");
        const observation = hint(
          "response",
          response.ok ? "ACCEPTED_PROVISIONAL" : "REJECTED_PROVISIONAL",
          response,
        );
        const metadata = await responseJson(response, controller.signal);
        const details = {
          ...observation,
          objectId:
            typeof metadata.Id === "string" ? bounded(metadata.Id) : null,
          errorCode:
            errorCode(metadata.code) ??
            errorCode(metadata.error) ??
            observation.errorCode,
        };
        await this.deps.report(details);
        void response.body?.cancel().catch(() => {});
        if (response.ok && !complete) throw Error("INPUT_NOT_EXHAUSTED");
        return {
          kind: "response" as const,
          provenance: "authenticated-storage-response" as const,
          status: response.status,
          requestId: observation.requestId,
          version: observation.version,
          etag: observation.etag,
          // HTTP success does not establish an acknowledged object byte count.
          acknowledgedBytes: null,
        };
      };
      return await Promise.race([work(), aborted]);
    } catch (error) {
      if (
        error instanceof Error &&
        ["REDIRECT_REJECTED", "INPUT_NOT_EXHAUSTED"].includes(error.message)
      )
        failure = error.message;
      try {
        await deadline(this.deps.timeoutMs, new AbortController().signal, () =>
          this.deps.report(hint("unknown", failure)),
        );
      } catch {
        throw Error("EVIDENCE_FAILURE");
      }
      throw Error(failure);
    } finally {
      clearTimeout(timer);
      controller.abort();
      input.signal.removeEventListener("abort", externalAbort);
      // Never await an uncooperative producer/HTTP client during cancellation.
      void stream?.cancel().catch(() => {});
      void iterator.return?.().catch(() => {});
    }
  }

  temporaryResources() {
    return {
      supported: false,
      discovery: "unknown",
      retainHolds: true,
      certified: false,
    } as const;
  }

  /** Authenticated hints only. A 404 is masked/unknown, never physical absence. */
  async inspect(
    intent: WriteIntent | SeededFixture,
    kind: "metadata" | "hash" | "list",
    signal: AbortSignal,
  ) {
    if (!this.deps.enabled) throw Error("TRANSPORT_DISABLED");
    if (!["metadata", "hash", "list"].includes(kind))
      throw Error("UNSUPPORTED_INSPECTION");
    intent = Object.freeze({ ...intent });
    return deadline(this.deps.timeoutMs, signal, (combined) =>
      this.inspectWithin(intent, kind, combined),
    );
  }
  private async inspectWithin(
    intent: WriteIntent | SeededFixture,
    kind: "metadata" | "hash" | "list",
    combined: AbortSignal,
  ) {
    const path = this.scope(intent);
    const headers = await this.headers();
    combined.throwIfAborted();
    const list = kind === "list";
    const response = await this.deps.fetch(
      `${this.endpoint}/${list ? `object/list/${segments(intent.bucket)}` : kind === "metadata" ? `object/info/${path}` : `object/${path}`}`,
      {
        method: list ? "POST" : "GET",
        headers: { ...headers, "Content-Type": "application/json" },
        body: list
          ? JSON.stringify({
              prefix: this.deps.prefix + "/",
              limit: 100,
              offset: 0,
              sortBy: { column: "name", order: "asc" },
            })
          : undefined,
        redirect: "error",
        signal: combined,
      },
    );
    const base = {
      status: response.status,
      visibility: "unknown",
      discovery: list ? "incomplete" : "unknown",
      retainHolds: true,
      certified: false,
      futureProviderEffectsPossible: true,
    } as const;
    if (!response.ok || response.redirected || !response.body) {
      void response.body?.cancel().catch(() => {});
      return base;
    }
    if (combined.aborted) {
      void response.body.cancel().catch(() => {});
      throw Error("INSPECTION_UNKNOWN");
    }
    const reader = response.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    combined.addEventListener("abort", cancel, { once: true });
    const hash = createHash("sha256");
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      const advertised = response.headers.get("content-length");
      if (
        advertised !== null &&
        (!/^\d+$/.test(advertised) ||
          Number(advertised) >
            (kind === "hash" ? this.deps.maximumEncodedBytes : 65536))
      )
        throw Error("INSPECTION_LIMIT");
      while (true) {
        combined.throwIfAborted();
        const next = await reader.read();
        combined.throwIfAborted();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > (kind === "hash" ? this.deps.maximumEncodedBytes : 65536))
          throw Error("INSPECTION_LIMIT");
        if (kind === "hash") hash.update(next.value);
        else chunks.push(next.value);
      }
      if (kind === "hash") {
        if (advertised !== null && Number(advertised) !== bytes)
          throw Error("INSPECTION_INCOMPLETE");
        const sha256 = hash.digest("hex");
        return {
          ...base,
          visibility: "present" as const,
          bytes,
          responseBytes: bytes,
          sha256,
          matches:
            bytes === intent.declaredBytes && sha256 === intent.expectedSha256,
        };
      }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (advertised !== null && Number(advertised) !== bytes)
        throw Error("INSPECTION_INCOMPLETE");
      if (list && (!Array.isArray(data) || data.length > 100))
        throw Error("INSPECTION_LIST_LIMIT");
      // Bounded untrusted API data is returned only to the internal verifier.
      const size =
        typeof data === "object" && data !== null && "size" in data
          ? data.size
          : null;
      return {
        ...base,
        data,
        responseBytes: bytes,
        metadataBytes:
          kind === "metadata" && typeof size === "number" && count(size)
            ? size
            : null,
        metadataLengthMatches:
          kind === "metadata" && typeof size === "number"
            ? size === intent.declaredBytes
            : null,
      };
    } catch (error) {
      throw new InspectionFailure(
        response.status,
        bytes,
        error instanceof Error &&
          ["INSPECTION_LIMIT", "INSPECTION_LIST_LIMIT"].includes(error.message)
          ? error.message
          : undefined,
      );
    } finally {
      combined.removeEventListener("abort", cancel);
      void reader.cancel().catch(() => {});
    }
  }

  async deleteForTest(
    intent: WriteIntent,
    authorize: (intent: WriteIntent) => Promise<boolean>,
    signal: AbortSignal,
  ) {
    this.assertSupported("single-object-create");
    intentSchema.parse(intent);
    this.scope(intent);
    const snapshot = Object.freeze({ ...intent });
    return deadline(this.deps.timeoutMs, signal, async (combined) => {
      if (!(await authorize(snapshot))) throw Error("TEST_DELETE_UNAUTHORIZED");
      const headers = await this.headers();
      combined.throwIfAborted();
      const response = await this.deps.fetch(
        `${this.endpoint}/object/${segments(snapshot.bucket)}`,
        {
          method: "DELETE",
          headers: {
            ...headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prefixes: [snapshot.path] }),
          redirect: "error",
          signal: combined,
        },
      );
      void response.body?.cancel().catch(() => {});
      return {
        deletionStatus: response.status,
        after: await this.inspectWithin(snapshot, "metadata", combined),
        retainHolds: true,
        certified: false,
        futureProviderEffectsPossible: true,
      } as const;
    });
  }
}
