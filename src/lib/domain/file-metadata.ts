/** Display metadata is untrusted, never an object path or an integrity claim. */
export interface FileMetadata {
  originalName: string;
  originalMime: string | null;
}
const controls = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const mime = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
export function parseFileMetadata(value: unknown): FileMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("FILE_METADATA_INVALID");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) => !["originalName", "originalMime"].includes(key),
    ) ||
    typeof v.originalName !== "string" ||
    !v.originalName.trim() ||
    v.originalName === "." ||
    v.originalName === ".." ||
    new TextEncoder().encode(v.originalName).length > 255 ||
    controls.test(v.originalName) ||
    /[\\/]/.test(v.originalName) ||
    (v.originalMime !== null &&
      (typeof v.originalMime !== "string" ||
        v.originalMime.length > 127 ||
        !mime.test(v.originalMime)))
  )
    throw Error("FILE_METADATA_INVALID");
  return {
    originalName: v.originalName,
    originalMime: v.originalMime as string | null,
  };
}
/** Filename hints retain extensions; the browser/OS may further normalize them. */
export function attachmentName(metadata?: FileMetadata): string {
  if (!metadata) return "verified-restoration.bin";
  const name = parseFileMetadata(metadata)
    .originalName.replace(/[<>:"|?*]/g, "_")
    .replace(/[ .]+$/, "");
  if (!name) return "verified-restoration.bin";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    ? `_${name}`
    : name;
}
