import { createHash } from "node:crypto";

export const PROJECT = "mdyiczsuddpqgjtfofgs";
export const BUCKET = "smart-storage-feasibility";
export const RUN = "p14b-20261011-c40e8e03";
export const MAX_ALLOCATIONS = 12;
export const MAX_BYTES = 33_554_432;
export const CHUNK_BYTES = 6_291_456;
export const TUS_BYTES = CHUNK_BYTES + 1_024;
export type Actor = "A" | "B" | "anonymous";
export const USERS = {
  A: {
    id: "7aaa8834-54ec-4f57-ae96-080928d8f74f",
    email: "smart-storage-user-a@example.invalid",
  },
  B: {
    id: "4af63360-f59f-48d7-a745-49cb4339f26a",
    email: "smart-storage-user-b@example.invalid",
  },
} as const;
export const PATHS = Object.freeze(
  Object.entries(USERS).flatMap(([actor, user]) =>
    Array.from({ length: 6 }, (_, i) => ({
      actor: actor as "A" | "B",
      path: `${RUN}/${user.id}/${String(i + (actor === "A" ? 0 : 6)).padStart(2, "0")}.raw`,
    })),
  ),
);
export const slot = (n: number): string => {
  const item = PATHS[n];
  if (!item) throw new Error("INVALID_SLOT");
  return item.path;
};
export const hash = (input: string | Uint8Array) =>
  createHash("sha256").update(input).digest("hex");
export type Purpose =
  | "login"
  | "identity"
  | "rest-upload"
  | "download"
  | "cross-read"
  | "wrong-owner-upload"
  | "anonymous-read"
  | "tus-create"
  | "tus-head"
  | "tus-part"
  | "owner-info"
  | "cleanup";
export interface Intent {
  id: string;
  actor: Actor;
  purpose: Purpose;
  method: "GET" | "POST" | "HEAD" | "PATCH" | "DELETE";
  path?: string;
  resource?: string;
  offset?: number;
  length?: number;
  body?: Uint8Array;
  expected: "allow" | "deny";
}
export const STAGES = [
  {
    id: "login-A",
    actor: "A",
    purpose: "login",
    method: "POST",
    maxBytes: 16_384,
  },
  {
    id: "identity-A",
    actor: "A",
    purpose: "identity",
    method: "GET",
    maxBytes: 0,
  },
  {
    id: "login-B",
    actor: "B",
    purpose: "login",
    method: "POST",
    maxBytes: 16_384,
  },
  {
    id: "identity-B",
    actor: "B",
    purpose: "identity",
    method: "GET",
    maxBytes: 0,
  },
  {
    id: "rest-A",
    actor: "A",
    purpose: "rest-upload",
    method: "POST",
    path: slot(0),
    maxBytes: 256,
  },
  {
    id: "download-A",
    actor: "A",
    purpose: "download",
    method: "GET",
    path: slot(0),
    maxBytes: 0,
  },
  {
    id: "cross-read-B",
    actor: "B",
    purpose: "cross-read",
    method: "GET",
    path: slot(0),
    maxBytes: 0,
  },
  {
    id: "wrong-owner-B",
    actor: "B",
    purpose: "wrong-owner-upload",
    method: "POST",
    path: slot(1),
    maxBytes: 32,
  },
  {
    id: "anonymous-read",
    actor: "anonymous",
    purpose: "anonymous-read",
    method: "GET",
    path: slot(0),
    maxBytes: 0,
  },
  {
    id: "tus-create-A",
    actor: "A",
    purpose: "tus-create",
    method: "POST",
    path: slot(2),
    maxBytes: 0,
  },
  {
    id: "tus-head-zero",
    actor: "A",
    purpose: "tus-head",
    method: "HEAD",
    path: slot(2),
    maxBytes: 0,
  },
  {
    id: "tus-part-first",
    actor: "A",
    purpose: "tus-part",
    method: "PATCH",
    path: slot(2),
    maxBytes: CHUNK_BYTES,
  },
  {
    id: "tus-head-recovery",
    actor: "A",
    purpose: "tus-head",
    method: "HEAD",
    path: slot(2),
    maxBytes: 0,
  },
  {
    id: "tus-part-tail",
    actor: "A",
    purpose: "tus-part",
    method: "PATCH",
    path: slot(2),
    maxBytes: 1_024,
  },
  {
    id: "tus-head-complete",
    actor: "A",
    purpose: "tus-head",
    method: "HEAD",
    path: slot(2),
    maxBytes: 0,
  },
  {
    id: "owner-info-rest",
    actor: "A",
    purpose: "owner-info",
    method: "GET",
    path: slot(0),
    maxBytes: 0,
  },
  {
    id: "owner-info-tus",
    actor: "A",
    purpose: "owner-info",
    method: "GET",
    path: slot(2),
    maxBytes: 0,
  },
] as const;
export const MANIFEST_HASH = hash(
  JSON.stringify({
    PROJECT,
    BUCKET,
    RUN,
    PATHS,
    STAGES,
    MAX_ALLOCATIONS,
    MAX_BYTES,
  }),
);
export interface Approval {
  schemaVersion?: 2;
  issuedAt?: string;
  continuation?: {
    ledgerIdentity: string;
    generation: number;
    digest: string;
    stages: string[];
    initialAllocations: 1;
    initialBytes: 474;
    maxAdditionalAllocations: 2;
    maxAdditionalBytes: 6292512;
  };
  kind: "storage-provider-execution" | "storage-provider-cleanup";
  id: string;
  project: string;
  bucket: string;
  run: string;
  manifestHash: string;
  expiresAt: string;
  purposes: Purpose[];
  acknowledgedRuntimeUncertainties: true;
}
export function approve(
  value: Approval | undefined,
  confirmation: string | undefined,
  cleanup = false,
): Approval {
  if (value?.schemaVersion === 2) {
    const start = Date.parse(value.issuedAt ?? "");
    const end = Date.parse(value.expiresAt);
    const c = value.continuation;
    if (
      !Number.isFinite(start) ||
      start > Date.now() ||
      end <= start ||
      end - start > 30 * 60_000 ||
      !c ||
      value.kind !== "storage-provider-execution" ||
      !/^[a-f0-9]{64}$/.test(c.ledgerIdentity) ||
      !/^[a-f0-9]{64}$/.test(c.digest) ||
      !Number.isSafeInteger(c.generation) ||
      c.generation < 0 ||
      JSON.stringify(c.stages) !==
        JSON.stringify(STAGES.slice(7).map((s) => s.id)) ||
      c.initialAllocations !== 1 ||
      c.initialBytes !== 474 ||
      c.maxAdditionalAllocations !== 2 ||
      c.maxAdditionalBytes !== 6292512 ||
      JSON.stringify([...value.purposes].sort()) !==
        JSON.stringify(
          [...new Set(STAGES.slice(7).map((s) => s.purpose))].sort(),
        )
    )
      throw new Error("CONTINUATION_APPROVAL_REQUIRED");
  } else if (
    value?.continuation ||
    value?.issuedAt ||
    value?.schemaVersion !== undefined
  ) {
    throw new Error("CONTINUATION_APPROVAL_REQUIRED");
  }
  if (
    !value ||
    value.id.length < 16 ||
    confirmation !== value.id ||
    value.kind !==
      (cleanup ? "storage-provider-cleanup" : "storage-provider-execution") ||
    value.project !== PROJECT ||
    value.bucket !== BUCKET ||
    value.run !== RUN ||
    value.manifestHash !== MANIFEST_HASH ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= Date.now() ||
    value.acknowledgedRuntimeUncertainties !== true ||
    !Array.isArray(value.purposes) ||
    value.purposes.length === 0 ||
    value.purposes.some(
      (p) => !STAGES.some((s) => s.purpose === p) && p !== "cleanup",
    ) ||
    (!cleanup && value.purposes.includes("cleanup")) ||
    (cleanup && value.purposes.some((p) => p !== "cleanup"))
  )
    throw new Error("APPROVAL_REQUIRED");
  return value;
}
export function validateIntent(
  intent: Intent,
  cleanupPaths: string[] = [],
): { allocation: boolean; maximumBody: number } {
  const path = intent.path;
  if (path && !PATHS.some((p) => p.path === path))
    throw new Error("PATH_NOT_ALLOWLISTED");
  if (intent.purpose === "cleanup") {
    if (
      intent.method !== "DELETE" ||
      !path ||
      intent.actor === "anonymous" ||
      !cleanupPaths.includes(path) ||
      !PATHS.some((p) => p.actor === intent.actor && p.path === path) ||
      intent.body?.byteLength
    )
      throw new Error("CLEANUP_NOT_ELIGIBLE");
    return { allocation: false, maximumBody: 0 };
  }
  const stage = STAGES.find((s) => s.id === intent.id);
  if (
    !stage ||
    stage.actor !== intent.actor ||
    stage.method !== intent.method ||
    stage.purpose !== intent.purpose ||
    ("path" in stage ? stage.path : undefined) !== path
  )
    throw new Error("INTENT_NOT_APPROVED");
  const denial = [
    "cross-read",
    "wrong-owner-upload",
    "anonymous-read",
  ].includes(intent.purpose);
  if (intent.expected !== (denial ? "deny" : "allow"))
    throw new Error("EXPECTATION_MISMATCH");
  if (
    !denial &&
    path &&
    !PATHS.some((p) => p.path === path && p.actor === intent.actor)
  )
    throw new Error("ACTOR_PATH_MISMATCH");
  if ((intent.body?.byteLength ?? 0) > stage.maxBytes)
    throw new Error("STAGE_BODY_LIMIT");
  if (
    intent.purpose === "tus-part" &&
    (intent.body?.byteLength !== stage.maxBytes ||
      intent.offset !== (intent.id === "tus-part-first" ? 0 : CHUNK_BYTES))
  )
    throw new Error("TUS_CHUNK_SEQUENCE_REQUIRED");
  return {
    allocation: ["rest-upload", "wrong-owner-upload", "tus-create"].includes(
      intent.purpose,
    ),
    maximumBody: stage.maxBytes,
  };
}
export function fixture(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0 || length > TUS_BYTES)
    throw new Error("FIXTURE_TOO_LARGE");
  return Uint8Array.from({ length }, (_, i) => (i * 31 + 17) % 251);
}
export function boundResource(location: string, path: string): string {
  const url = new URL(location);
  const prefix = "/storage/v1/upload/resumable/";
  if (
    url.origin !== `https://${PROJECT}.storage.supabase.co` ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(prefix)
  )
    throw new Error("UNEXPECTED_RESOURCE");
  const encoded = url.pathname.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("UNEXPECTED_RESOURCE");
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  const start = `${BUCKET}/${path}/`;
  if (
    !decoded.startsWith(start) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      decoded.slice(start.length),
    )
  )
    throw new Error("UNEXPECTED_RESOURCE");
  return url.href;
}
