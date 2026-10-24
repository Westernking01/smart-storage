import { z } from "zod";
import { parseDecimalBytes } from "../domain/control-contracts";
export const bytes = z.string().transform((s, ctx) => {
  try {
    return parseDecimalBytes(s);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid byte count" });
    return z.NEVER;
  }
});
export const ownedFile = z
  .object({
    id: z.uuid(),
    displayName: z.string().max(255),
    originalName: z.string().max(255),
    originalMime: z.string().nullable(),
    category: z.enum([
      "document",
      "image",
      "video",
      "audio",
      "archive",
      "other",
    ]),
    state: z.enum(["uploading", "ready", "failed", "deleting", "deleted"]),
    originalBytes: bytes,
    encodedBytes: bytes.nullable(),
    manifestBytes: bytes.nullable(),
    storedBytes: bytes.nullable(),
    createdAt: z.string(),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type OwnedFile = z.infer<typeof ownedFile>;
export const account = z
  .object({
    id: z.uuid(),
    needsBootstrap: z.boolean(),
    usage: z
      .object({
        quotaBytes: bytes,
        storedBytes: bytes,
        reservedBytes: bytes,
        activeSlots: z.number().int().nonnegative(),
        maxSlots: z.number().int().nonnegative(),
        historicalOriginalBytes: bytes,
        historicalStoredBytes: bytes,
      })
      .strict()
      .optional(),
  })
  .strict();
export const cursorSchema = z
  .object({ at: z.iso.datetime({ offset: true }), id: z.uuid() })
  .strict();
export function readCursor(input?: string) {
  if (!input) return null;
  return cursorSchema.parse(
    JSON.parse(Buffer.from(input, "base64url").toString("utf8")),
  );
}
export function nextCursor(file: OwnedFile) {
  return Buffer.from(
    JSON.stringify({ at: file.createdAt, id: file.id }),
  ).toString("base64url");
}
