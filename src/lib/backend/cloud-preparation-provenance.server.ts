import "server-only";
import { BackendError } from "./operations";
import { z } from "zod";
import { digest, transform } from "../transfers/codec";

/** Browser markers are never authority. Bind permits to owner-filtered durable
 * allocation metadata and verify actual bytes before provider dispatch. */
export function preparationBinding(block: Record<string, unknown>) {
  return JSON.stringify([
    block.id,
    block.owner_id,
    block.session_id,
    block.block_index,
    block.original_offset,
    block.codec,
    block.original_bytes,
    block.encoded_bytes,
    block.original_sha256,
    block.encoded_sha256,
  ]);
}

/** Trusted write admission, not historical browser proof. Reservation remains
 * provisional; full original integrity is checked separately at publication. */
export async function requireCloudPreparationProvenance(
  body: Uint8Array<ArrayBuffer>,
  allocation: Record<string, unknown>,
  maximum: number,
): Promise<void> {
  const result = z
    .object({
      codec: z.literal("gzip"),
      original_bytes: z.number().int().min(1).max(maximum),
      encoded_bytes: z.number().int().min(1).max(maximum),
      original_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      encoded_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .safeParse(allocation);
  if (!result.success)
    throw new BackendError("CLOUD_PREPARATION_UNVERIFIED", 409);
  const block = result.data;
  if (
    body.length !== block.encoded_bytes ||
    digest(body) !== block.encoded_sha256
  )
    throw new BackendError("STAGED_INTEGRITY", 409);
  let restored: Uint8Array<ArrayBuffer>;
  try {
    restored = await transform(body, "decode", block.original_bytes);
  } catch {
    throw new BackendError("STAGED_INTEGRITY", 409);
  }
  if (
    restored.length !== block.original_bytes ||
    digest(restored) !== block.original_sha256
  )
    throw new BackendError("ORIGINAL_BLOCK_INTEGRITY", 409);
}
