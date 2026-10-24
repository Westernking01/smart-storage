import { z } from "zod";
import { ownedFile } from "./files";
const name = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (v) =>
      new TextEncoder().encode(v).length <= 255 &&
      !/[\\/\u0000-\u001f\u007f]/.test(v) &&
      v !== "." &&
      v !== "..",
  );
export const explorerQuery = z
  .object({
    folder: z.uuid().optional(),
    query: z.string().max(128).default(""),
    sort: z.enum(["name", "type", "size", "date"]).default("name"),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();
export const explorerCommand = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      id: z.uuid(),
      parent: z.uuid().nullable(),
      name,
    })
    .strict(),
  z
    .object({
      action: z.literal("rename"),
      id: z.uuid(),
      name,
      revision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal("move"),
      id: z.uuid(),
      folder: z.uuid().nullable(),
      revision: z.number().int().nonnegative(),
    })
    .strict(),
]);
export const folderRecord = z
  .object({
    id: z.uuid(),
    name: z.string(),
    parentId: z.uuid().nullable(),
    createdAt: z.string().optional(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export const explorerListing = z
  .object({
    folders: z.array(folderRecord).max(256),
    breadcrumbs: z.array(folderRecord).max(16),
    files: z
      .array(
        z
          .object({
            file: ownedFile,
            folderId: z.uuid().nullable(),
            locationRevision: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(25),
    next: z.number().int().min(0).max(100000).nullable(),
  })
  .strict();
export const moveReceipt = z
  .object({
    id: z.uuid(),
    folderId: z.uuid().nullable(),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
