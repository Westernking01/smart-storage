import {
  canonical,
  fail,
  HASH,
  integer,
  parseBlock,
  parseManifest,
  record,
  BLOCK_BYTES,
  FILE_BYTES,
  type Block,
  type Manifest,
} from "./format";
import { digest } from "./codec";
import { parseFileMetadata, type FileMetadata } from "../domain/file-metadata";
export type Phase =
  | "preparing"
  | "prepared"
  | "uploading"
  | "acknowledged"
  | "completed"
  | "failed"
  | "ambiguous"
  | "cancelled"
  | "abandoned";
export interface Progress {
  block: Block;
  phase: Exclude<Phase, "preparing" | "cancelled" | "abandoned">;
  acknowledgedBytes: number;
  attemptedBytes: number;
  attemptId: string | null;
}
export interface Checkpoint {
  version: 1;
  id: string;
  revision: number;
  originalBytes: number;
  sourceSha256: string;
  blockSize: number;
  phase: Phase;
  blocks: Progress[];
  manifest: Manifest | null;
  metadata?: FileMetadata;
  displayName?: string;
  createdAt?: string;
  ownerId?: string;
  verifiedPreparation?: string;
  localPayloadRemoved?: true;
  publication?: "intent" | "dispatched" | "cancelled-before-dispatch";
}
export const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const phases: Phase[] = [
  "preparing",
  "prepared",
  "uploading",
  "acknowledged",
  "completed",
  "failed",
  "ambiguous",
  "cancelled",
  "abandoned",
];
export function validateCheckpoint(value: unknown): Checkpoint {
  const c = record(value);
  if (c.localPayloadRemoved !== undefined && c.localPayloadRemoved !== true)
    fail("CHECKPOINT_INVALID");
  if (
    c.publication !== undefined &&
    !["intent", "dispatched", "cancelled-before-dispatch"].includes(
      String(c.publication),
    )
  )
    fail("CHECKPOINT_INVALID");
  if (
    c.ownerId !== undefined &&
    (typeof c.ownerId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        c.ownerId,
      ))
  )
    fail("CHECKPOINT_OWNER_INVALID");
  if (
    c.version !== 1 ||
    typeof c.id !== "string" ||
    !UUID.test(c.id) ||
    !integer(c.revision) ||
    !integer(c.originalBytes) ||
    c.originalBytes > FILE_BYTES ||
    typeof c.sourceSha256 !== "string" ||
    !HASH.test(c.sourceSha256) ||
    !integer(c.blockSize) ||
    c.blockSize < 65536 ||
    c.blockSize > BLOCK_BYTES ||
    !phases.includes(c.phase as Phase) ||
    !Array.isArray(c.blocks) ||
    c.blocks.length > 128 ||
    c.blocks.length > Math.max(1, Math.ceil(c.originalBytes / c.blockSize))
  )
    fail("CHECKPOINT_INVALID");
  if (
    c.displayName !== undefined &&
    (typeof c.displayName !== "string" ||
      parseFileMetadata({ originalName: c.displayName, originalMime: null })
        .originalName !== c.displayName)
  )
    fail("CHECKPOINT_DISPLAY_NAME_INVALID");
  if (
    c.createdAt !== undefined &&
    (typeof c.createdAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(c.createdAt) ||
      !Number.isFinite(Date.parse(c.createdAt)))
  )
    fail("CHECKPOINT_CREATED_AT_INVALID");
  const blocks: Progress[] = c.blocks.map((v, index) => {
    const p = record(v);
    const b = parseBlock(
      p.block,
      index,
      index * Number(c.blockSize),
      Math.min(
        Number(c.blockSize),
        Number(c.originalBytes) - index * Number(c.blockSize),
      ),
    );
    if (
      ![
        "prepared",
        "uploading",
        "acknowledged",
        "completed",
        "failed",
        "ambiguous",
      ].includes(String(p.phase)) ||
      !integer(p.acknowledgedBytes) ||
      p.acknowledgedBytes > b.encodedBytes ||
      !integer(p.attemptedBytes) ||
      p.attemptedBytes < p.acknowledgedBytes ||
      (p.attemptId !== null &&
        (typeof p.attemptId !== "string" || !UUID.test(p.attemptId))) ||
      (["uploading", "ambiguous"].includes(String(p.phase)) &&
        p.attemptId === null) ||
      (["completed", "acknowledged"].includes(String(p.phase)) &&
        p.acknowledgedBytes !== b.encodedBytes)
    )
      fail("CHECKPOINT_INVALID");
    return {
      block: b,
      phase: p.phase as Progress["phase"],
      acknowledgedBytes: p.acknowledgedBytes,
      attemptedBytes: p.attemptedBytes,
      attemptId: p.attemptId as string | null,
    };
  });
  const manifest = c.manifest === null ? null : parseManifest(c.manifest);
  if (
    c.verifiedPreparation !== undefined &&
    (typeof c.verifiedPreparation !== "string" ||
      !HASH.test(c.verifiedPreparation) ||
      !manifest ||
      c.verifiedPreparation !==
        digest(new TextEncoder().encode(canonical(manifest))))
  )
    fail("CHECKPOINT_PREPARATION_INVALID");
  if (
    manifest &&
    (manifest.originalBytes !== c.originalBytes ||
      manifest.blockSize !== c.blockSize ||
      manifest.originalSha256 !== c.sourceSha256 ||
      canonical(manifest.blocks) !== canonical(blocks.map((p) => p.block)))
  )
    fail("CHECKPOINT_MANIFEST_MISMATCH");
  if (
    ["prepared", "acknowledged", "completed"].includes(String(c.phase)) &&
    !manifest
  )
    fail("CHECKPOINT_INVALID");
  if (c.phase === "completed" && blocks.some((p) => p.phase !== "completed"))
    fail("CHECKPOINT_INVALID");
  return {
    version: 1,
    id: c.id,
    revision: c.revision,
    originalBytes: c.originalBytes,
    sourceSha256: c.sourceSha256,
    blockSize: c.blockSize,
    phase: c.phase as Phase,
    blocks,
    manifest,
    ...(c.publication === undefined
      ? {}
      : {
          publication: c.publication as
            "intent" | "dispatched" | "cancelled-before-dispatch",
        }),
    ...(c.ownerId === undefined ? {} : { ownerId: c.ownerId as string }),
    ...(c.localPayloadRemoved === true
      ? { localPayloadRemoved: true as const }
      : {}),
    ...(c.verifiedPreparation === undefined
      ? {}
      : { verifiedPreparation: c.verifiedPreparation as string }),
    ...(c.metadata === undefined
      ? {}
      : { metadata: parseFileMetadata(c.metadata) }),
    ...(c.displayName === undefined
      ? {}
      : { displayName: c.displayName as string }),
    ...(c.createdAt === undefined ? {} : { createdAt: c.createdAt as string }),
  };
}
export function envelope(c: Checkpoint) {
  const text = canonical(validateCheckpoint(c));
  return { text, checksum: digest(new TextEncoder().encode(text)) };
}
export function openEnvelope(value: unknown): Checkpoint {
  const e = record(value);
  if (
    typeof e.text !== "string" ||
    e.text.length > 256 * 1024 ||
    typeof e.checksum !== "string" ||
    digest(new TextEncoder().encode(e.text)) !== e.checksum
  )
    fail("CHECKPOINT_CORRUPT");
  return validateCheckpoint(JSON.parse(e.text));
}
export function totals(c: Checkpoint) {
  return {
    originalBytes: c.originalBytes,
    compressedBytes: c.blocks.reduce((n, p) => n + p.block.encodedBytes, 0),
    uploadedBytes: c.blocks.reduce((n, p) => n + p.acknowledgedBytes, 0),
    attemptedTransferBytes: c.blocks.reduce((n, p) => n + p.attemptedBytes, 0),
  };
}
export function validateTransition(old: Checkpoint, next: Checkpoint) {
  if (
    (old.localPayloadRemoved === true && next.localPayloadRemoved !== true) ||
    (old.publication === "dispatched" && next.publication !== "dispatched") ||
    old.id !== next.id ||
    next.revision !== old.revision + 1 ||
    old.originalBytes !== next.originalBytes ||
    old.sourceSha256 !== next.sourceSha256 ||
    old.blockSize !== next.blockSize ||
    old.ownerId !== next.ownerId ||
    (old.verifiedPreparation !== undefined &&
      old.verifiedPreparation !== next.verifiedPreparation) ||
    old.createdAt !== next.createdAt ||
    canonical(old.metadata ?? null) !== canonical(next.metadata ?? null) ||
    next.blocks.length < old.blocks.length ||
    next.blocks.length > old.blocks.length + 1 ||
    (old.manifest && canonical(old.manifest) !== canonical(next.manifest)) ||
    (["completed", "cancelled", "abandoned"].includes(old.phase) &&
      old.phase !== next.phase)
  )
    fail("CHECKPOINT_TRANSITION_INVALID");
  for (let i = 0; i < old.blocks.length; i++) {
    const before = old.blocks[i],
      after = next.blocks[i];
    if (
      canonical(before.block) !== canonical(after.block) ||
      after.attemptedBytes < before.attemptedBytes ||
      after.acknowledgedBytes < before.acknowledgedBytes ||
      (before.phase === "completed" && after.phase !== "completed")
    )
      fail("CHECKPOINT_TRANSITION_INVALID");
  }
}
export function recovery(c: Checkpoint) {
  return {
    checkpoint: c,
    requiresRemoteReconciliation:
      (c.publication === "dispatched" && c.phase !== "completed") ||
      ["uploading", "ambiguous"].includes(c.phase) ||
      c.blocks.some((p) => p.phase === "uploading" || p.phase === "ambiguous"),
    missingSource: c.manifest === null,
    completed: c.phase === "completed",
  };
}
