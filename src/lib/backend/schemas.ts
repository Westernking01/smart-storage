import { z } from "zod";
import { parseFileMetadata } from "../domain/file-metadata";
import { parseCreateSession } from "../domain/control-contracts";
export const email = z.string().trim().email().max(254);
export const password = z.string().min(12).max(128);
export const authInput = {
  login: z
    .object({
      email,
      password: z.string().min(1).max(128),
      next: z.string().max(150).optional(),
    })
    .strict(),
  register: z.object({ email, password }).strict(),
  reset: z.object({ email }).strict(),
  update: z.object({ password }).strict(),
  logout: z.object({}).strict(),
};
export const category = z.enum([
  "document",
  "image",
  "video",
  "audio",
  "archive",
  "other",
]);
export const fileEdit = z
  .object({
    displayName: z.string().superRefine((name, ctx) => {
      try {
        parseFileMetadata({ originalName: name, originalMime: null });
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "Use a valid filename up to 255 UTF-8 bytes.",
        });
      }
    }),
    category,
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const uuid = z.uuid();
export const pageInput = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(25),
    cursor: z.string().max(150).optional(),
  })
  .strict();
export const sessionInput = z.unknown().transform((value, ctx) => {
  try {
    return parseCreateSession(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid upload session." });
    return z.NEVER;
  }
});
