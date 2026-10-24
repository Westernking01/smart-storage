import { z } from "zod";

/** Inspection provenance only. Contains no upload, reservation or dispatch IDs. */
export const seededFixtureSchema = z
  .object({
    operation: z.literal("seeded-fixture-inspection"),
    provenance: z.literal("externally-seeded-operator-fixture"),
    registrationId: z.uuid(),
    ownerId: z.literal("310d0ec8-84ca-423a-b646-0480a20edc09"),
    project: z.literal("rrylhvqalsxjnkdkpwde"),
    bucket: z.literal("smart-storage-gateway-probe"),
    path: z.literal("gateway-probe/v1/probe-fixture-v1.txt"),
    declaredBytes: z.literal(123),
    expectedSha256: z.literal(
      "57d60b8f171ecb27ee614e0a518b3bfba7d8c994bb4daf20c496818970d4c511",
    ),
    verificationReference: z.string().min(1).max(256),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type SeededFixture = z.infer<typeof seededFixtureSchema>;
