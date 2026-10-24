import "server-only";
import { z } from "zod";

/** Nonsecret, local-only plan. This is not approval to authenticate. */
export const probeAuthPlanSchema = z
  .object({
    enabled: z.literal(false),
    project: z.literal("rrylhvqalsxjnkdkpwde"),
    authEndpoint: z.literal("https://rrylhvqalsxjnkdkpwde.supabase.co/auth/v1"),
    userId: z.literal("310d0ec8-84ca-423a-b646-0480a20edc09"),
    method: z.literal("password"),
    apiKeyKind: z.literal("publishable"),
    persistSession: z.literal(false),
    autoRefreshToken: z.literal(false),
    detectSessionInUrl: z.literal(false),
    storage: z.literal("process-memory-only"),
    maximumSignInAttempts: z.literal(1),
    maximumIdentityChecks: z.literal(1),
    maximumSessionUseMs: z.literal(1800000),
    minimumRemainingLifetimeSeconds: z.literal(120),
    retries: z.literal(0),
    redirects: z.literal(0),
  })
  .strict();

const permissionReview = z
  .object({
    project: z.literal("rrylhvqalsxjnkdkpwde"),
    userId: z.literal("310d0ec8-84ca-423a-b646-0480a20edc09"),
    bucket: z.literal("smart-storage-gateway-probe"),
    key: z.literal("gateway-probe/v1/probe-fixture-v1.txt"),
    policyName: z.literal("smart_storage_probe_read_only"),
    privateBucketConfirmed: z.literal(true),
    rlsEnabled: z.literal(true),
    selectPredicateBindsExactUidBucketKey: z.literal(true),
    applicableRolesReviewed: z.literal(true),
    allPoliciesAndGrantsReviewed: z.literal(true),
    noBroaderEffectiveAccess: z.literal(true),
    noWriteOrAdministrativeAccess: z.literal(true),
    reviewReference: z.string().min(1).max(256),
  })
  .strict();

/** Operator review gate only: no SQL, network, credential or JWT access.
 * A successful parse does not prove deployed policy semantics. */
export function preflightProbeAuthentication(plan: unknown, review: unknown) {
  probeAuthPlanSchema.parse(plan);
  permissionReview.parse(review);
  return { readyForSeparateAuthenticationAuthorization: true } as const;
}

/** Seeded inspection configuration only; never proof of effective API access. */
export const seededFixtureConfigurationReviewSchema = permissionReview
  .omit({ noBroaderEffectiveAccess: true, noWriteOrAdministrativeAccess: true })
  .extend({
    reviewKind: z.literal("seeded-fixture-configuration-v1"),
    checkedRoleMembershipsReviewed: z.literal(true),
    reportedSelectBoundaryReviewed: z.literal(true),
    reportedMutationPolicyAbsenceReviewed: z.literal(true),
    effectiveStorageApiBehavior: z.literal("UNVERIFIED"),
  })
  .strict();

export function preflightSeededFixtureAuthentication(
  plan: unknown,
  review: unknown,
) {
  probeAuthPlanSchema.parse(plan);
  seededFixtureConfigurationReviewSchema.parse(review);
  return { readyForSeparateAuthenticationAuthorization: true } as const;
}
