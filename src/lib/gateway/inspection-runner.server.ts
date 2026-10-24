import "server-only";
import { createHash } from "node:crypto";
import { createBoundedProbeHttp } from "./bounded-probe-http.server";
import { z } from "zod";
import {
  seededFixtureSchema,
  type SeededFixture,
} from "./seeded-fixture-contract";
import {
  SupabaseStorageTransport,
  InspectionFailure,
  type TransportDependencies,
} from "./supabase-storage-transport.server";
import {
  anyInspectionSchema as inspectionSchema,
  inspectionSchema as uploadInspectionSchema,
  type AnyInspectionObservation as InspectionObservation,
  type InspectionSink,
} from "./inspection-evidence.server";

const uploadTargetSchema = uploadInspectionSchema
  .pick({ intent: true, scope: true })
  .extend({
    project: z.string().regex(/^[a-z]{20}$/),
    endpoint: z.url(),
    prefix: z.string().min(1),
  })
  .strict();
export type ProbeTarget = z.infer<typeof uploadTargetSchema>;
const targetSchema = uploadTargetSchema.extend({
  intent: z.union([uploadInspectionSchema.shape.intent, seededFixtureSchema]),
});
export type InspectionTarget = z.infer<typeof targetSchema>;
export type ProbeAuthorization = Readonly<{
  target: InspectionTarget;
  authorizationId: string;
  expiresAt: number;
  readOnly: true;
  /** Explicit scope agreement; this transport cannot enforce physical wire bytes. */
  accounting: "accepted-raw-response-body";
}>;
const key = (id: string, phase: string) => {
  const h = createHash("sha256")
    .update(JSON.stringify(["inspection-v1", id, phase]))
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** No CLI/env/credential fallback. Caller supplies separately approved target and
 * dedicated credentials; injected HTTP must enforce no retries/redirects. */
export class ReadOnlyInspectionRunner {
  private readonly used = new Set<string>();
  constructor(
    private readonly deps: {
      enabled?: boolean;
      target?: InspectionTarget;
      authorization?: ProbeAuthorization;
      credentials: TransportDependencies["credentials"];
      fetch?: TransportDependencies["fetch"];
      sink: InspectionSink;
      resolveSeeded?: () => Promise<SeededFixture>;
      fence: { claim(authorizationId: string, kind: string): Promise<void> };
    },
  ) {}
  async run(
    kind: "metadata" | "hash" | "list",
    operationId: string,
    signal: AbortSignal,
  ) {
    if (this.deps.enabled !== true) throw Error("PROBE_DISABLED");
    const target = targetSchema.parse(this.deps.target);
    const auth = this.deps.authorization
      ? structuredClone(this.deps.authorization)
      : undefined;
    if (
      !auth ||
      !auth.authorizationId ||
      auth.readOnly !== true ||
      auth.accounting !== "accepted-raw-response-body" ||
      !Number.isSafeInteger(auth.expiresAt) ||
      auth.expiresAt <= Date.now() ||
      JSON.stringify(targetSchema.parse(auth.target)) !== JSON.stringify(target)
    )
      throw Error("PROBE_UNAUTHORIZED");
    if (
      target.project === "fneuqneqaopkmpeevlqz" ||
      target.endpoint !== `https://${target.project}.supabase.co/storage/v1`
    )
      throw Error("PROBE_TARGET_REJECTED");
    if (
      target.intent.declaredBytes > 65536 ||
      !target.intent.path.startsWith(target.prefix + "/")
    )
      throw Error("PROBE_SCOPE_REJECTED");
    z.uuid().parse(operationId);
    if (!["metadata", "hash", "list"].includes(kind))
      throw Error("UNSUPPORTED_INSPECTION");
    if (
      target.intent.operation === "seeded-fixture-inspection" &&
      (target.intent.expiresAt <= Date.now() ||
        target.project !== target.intent.project)
    )
      throw Error("STALE_SEEDED_REGISTRATION");
    const identity =
      target.intent.operation === "seeded-fixture-inspection"
        ? ["seeded-fixture-inspection", target.intent.registrationId]
        : [target.intent.requestId, target.intent.resourceId];
    const verifyRegistration = async () => {
      if (target.intent.operation !== "seeded-fixture-inspection") return;
      if (!this.deps.resolveSeeded) throw Error("SEEDED_RESOLVER_REQUIRED");
      const registered = seededFixtureSchema.parse(
        await this.deps.resolveSeeded(),
      );
      if (
        registered.expiresAt <= Date.now() ||
        JSON.stringify(registered) !== JSON.stringify(target.intent)
      )
        throw Error("REGISTERED_SCOPE_MISMATCH");
    };
    await verifyRegistration();
    if (this.used.has(kind)) throw Error("PROBE_ATTEMPT_CONSUMED");
    const transport = new SupabaseStorageTransport({
      endpoint: target.endpoint,
      bucket: target.intent.bucket,
      prefix: target.prefix,
      maximumEncodedBytes: 65536,
      timeoutMs: 30000,
      enabled: true,
      credentials: this.deps.credentials,
      fetch: async (url, init) => {
        if (auth.expiresAt <= Date.now() || init.signal?.aborted)
          throw Error("PROBE_UNAUTHORIZED");
        return (this.deps.fetch ?? createBoundedProbeHttp(target.endpoint))(
          url,
          {
            ...init,
            headers: {
              ...init.headers,
              ...(kind === "hash" ? { Range: "bytes=0-65535" } : {}),
            },
          },
        );
      },
      report: async () => {
        throw Error("WRITES_PROHIBITED");
      },
      exposureBound: () => null,
    });
    const base = {
      intent: target.intent,
      scope: target.scope,
      kind,
      listing:
        kind === "list"
          ? { prefix: target.prefix + "/", offset: 0, limit: 100 }
          : null,
      classification: "provisional",
      retainHolds: true,
      certified: false,
      futureProviderEffectsPossible: true,
    } as const;
    const initial = inspectionSchema.parse({
      ...base,
      operationId: key(
        JSON.stringify([auth.authorizationId, kind, operationId, ...identity]),
        "intent",
      ),
      phase: "intent",
      observedAt: new Date().toISOString(),
      direct: {
        status: null,
        bytes: null,
        responseBytes: null,
        sha256: null,
        entries: null,
      },
      inference: "pending",
    });
    this.used.add(kind);
    await this.deps.fence.claim(auth.authorizationId, kind);
    await this.deps.sink.append(initial);
    let final: InspectionObservation;
    try {
      // Recheck expiry after durable preflight; never dispatch expired authority.
      if (auth.expiresAt <= Date.now()) throw Error("PROBE_UNAUTHORIZED");
      await verifyRegistration();
      const result = await transport.inspect(target.intent, kind, signal);
      const hash = "sha256" in result ? result.sha256 : null;
      const entries =
        "data" in result && Array.isArray(result.data)
          ? result.data.length
          : null;
      final = inspectionSchema.parse({
        ...base,
        operationId: key(
          JSON.stringify([
            auth.authorizationId,
            kind,
            operationId,
            ...identity,
          ]),
          "result",
        ),
        phase: "result",
        observedAt: new Date().toISOString(),
        direct: {
          status: result.status,
          bytes:
            "bytes" in result
              ? result.bytes
              : "metadataBytes" in result
                ? result.metadataBytes
                : null,
          responseBytes:
            "responseBytes" in result ? result.responseBytes : null,
          sha256: hash,
          entries: entries !== null && entries <= 100 ? entries : null,
        },
        inference: hash
          ? "matches" in result && result.matches
            ? "matches"
            : "mismatch"
          : kind === "list"
            ? "incomplete"
            : "metadataLengthMatches" in result &&
                result.metadataLengthMatches !== null
              ? result.metadataLengthMatches
                ? "matches"
                : "mismatch"
              : "unknown",
      });
    } catch (error) {
      final = inspectionSchema.parse({
        ...base,
        operationId: key(
          JSON.stringify([
            auth.authorizationId,
            kind,
            operationId,
            ...identity,
          ]),
          "result",
        ),
        phase: "result",
        observedAt: new Date().toISOString(),
        direct: {
          status: error instanceof InspectionFailure ? error.status : null,
          bytes: null,
          responseBytes:
            error instanceof InspectionFailure ? error.responseBytes : null,
          sha256: null,
          entries: null,
        },
        inference: "unknown",
      });
    }
    // Persistence failure rejects; no retry or conversion to provider success.
    await this.deps.sink.append(final);
    return final;
  }
}
