import "server-only";
import { z } from "zod";
import { win32 } from "node:path";
import type { InspectionTarget } from "./inspection-runner.server";

const destination = z
  .object({
    observer: z.literal(
      "postgresql://127.0.0.1:5432/smart_storage_gateway_test",
    ),
    observerRole: z.literal("ss_gateway_observer_runtime_test"),
    evidenceDirectory: z
      .string()
      .refine(
        (v) =>
          win32.isAbsolute(v) && !v.startsWith("\\\\") && !v.includes(".."),
      ),
    restrictedAclReviewed: z.literal(true),
  })
  .strict();
const scope = z
  .object({
    project: z.literal("rrylhvqalsxjnkdkpwde"),
    endpoint: z.literal("https://rrylhvqalsxjnkdkpwde.supabase.co/storage/v1"),
    bucket: z.literal("smart-storage-gateway-probe"),
    privateBucket: z.literal(true),
    prefix: z.literal("gateway-probe/v1/"),
    key: z.literal("gateway-probe/v1/probe-fixture-v1.txt"),
    userId: z.literal("310d0ec8-84ca-423a-b646-0480a20edc09"),
    expectedBytes: z.number().int().min(0).max(65536),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
    independentFixtureVerification: z.string().min(1).max(256),
    destinations: destination,
  })
  .strict();
export const disposableProbeConfigSchema = scope
  .extend({ enabled: z.boolean().default(false) })
  .strict();
export const disposableProbeAuthorizationSchema = scope
  .extend({
    authorizationId: z.uuid(),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    readOnly: z.literal(true),
    operations: z
      .object({
        metadata: z.literal(1),
        hash: z.literal(1),
        list: z.literal(1),
      })
      .strict(),
    maximumResponseBodyBytesPerOperation: z.literal(65536),
    maximumListEntries: z.literal(100),
    timeoutMs: z.literal(30000),
    retries: z.literal(0),
    redirects: z.literal(0),
    accounting: z.literal("accepted-raw-response-body"),
    physicalOverheadUnboundedAcknowledged: z.literal(true),
  })
  .strict();

/** Pure local validation. No I/O, credentials, environment or connection fallback.
 * Call again at each operation boundary; existing runner checks expiry at dispatch.
 * Review attestations are operator inputs, not proof of provider policy or ACLs. */
export function preflightDisposableProbe(
  config: unknown,
  authorization: unknown,
  target: InspectionTarget,
  destinations: unknown,
  operation: string,
  now = Date.now(),
) {
  const c = disposableProbeConfigSchema.parse(config);
  const a = disposableProbeAuthorizationSchema.parse(authorization);
  if (!c.enabled) throw Error("PROBE_DISABLED");
  if (
    !Number.isSafeInteger(now) ||
    a.issuedAt > now ||
    a.expiresAt <= now ||
    a.expiresAt <= a.issuedAt ||
    a.expiresAt - a.issuedAt > 30 * 60 * 1000
  )
    throw Error("PROBE_UNAUTHORIZED");
  if (!["metadata", "hash", "list"].includes(operation))
    throw Error("UNSUPPORTED_INSPECTION");
  if (
    JSON.stringify(scope.strip().parse(c)) !==
      JSON.stringify(scope.strip().parse(a)) ||
    JSON.stringify(destination.parse(destinations)) !==
      JSON.stringify(c.destinations) ||
    target.project !== c.project ||
    target.endpoint !== c.endpoint ||
    target.prefix !== c.prefix.slice(0, -1) ||
    target.intent.bucket !== c.bucket ||
    target.intent.path !== c.key ||
    target.intent.ownerId !== c.userId ||
    target.intent.declaredBytes !== c.expectedBytes ||
    target.intent.expectedSha256 !== c.expectedSha256
  )
    throw Error("PROBE_SCOPE_REJECTED");
  return {
    target: structuredClone(target),
    authorizationId: a.authorizationId,
    expiresAt: a.expiresAt,
    readOnly: a.readOnly,
    accounting: a.accounting,
  };
}
