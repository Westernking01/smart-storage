import { BUCKET, USERS, slot, type Intent } from "./manifest.js";

export interface ProviderError {
  code: string;
  logicalStatus?: number;
  message: "Object not found" | "REDACTED";
}
export interface KnownObject {
  bucket: string;
  path: string;
  ownerId: string;
  exists: boolean;
}
export function parseProviderError(value: unknown): ProviderError | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  const allowed = [
    "NoSuchKey",
    "NoSuchBucket",
    "AccessDenied",
    "InvalidRequest",
    "InvalidJWT",
  ];
  const code =
    typeof v.code === "string" && allowed.includes(v.code)
      ? v.code
      : "UNRECOGNIZED_PROVIDER_ERROR";
  const raw = v.statusCode ?? v.httpStatusCode;
  const status =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^[1-5][0-9]{2}$/.test(raw)
        ? Number(raw)
        : undefined;
  return {
    code,
    logicalStatus:
      status !== undefined &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
        ? status
        : undefined,
    message: v.message === "Object not found" ? "Object not found" : "REDACTED",
  };
}
export function isCrossReadDenial(
  intent: Intent,
  status: number,
  error: ProviderError | undefined,
  object: KnownObject | undefined,
): boolean {
  return (
    intent.id === "cross-read-B" &&
    intent.purpose === "cross-read" &&
    intent.actor === "B" &&
    intent.method === "GET" &&
    intent.path === slot(0) &&
    intent.expected === "deny" &&
    !intent.body?.byteLength &&
    status === 400 &&
    error?.code === "NoSuchKey" &&
    error.logicalStatus === 404 &&
    error.message === "Object not found" &&
    object?.exists === true &&
    object.bucket === BUCKET &&
    object.path === slot(0) &&
    object.ownerId === USERS.A.id
  );
}
