import "server-only";
import { randomUUID } from "node:crypto";
import {
  preflightSeededFixtureAuthHost,
  authenticateSeededFixtureHost,
} from "./probe-auth-host.server";
import {
  disposableProbeConfigSchema,
  disposableProbeAuthorizationSchema,
  preflightDisposableProbe,
} from "./disposable-probe-preflight.server";
import { seededFixtureSchema } from "./seeded-fixture-contract";
import {
  composeSeededFixtureProbe,
  registerSeededFixture,
} from "./seeded-fixture.server";
import { FileProbeFence } from "./probe-fence.server";
import type { GatewayPostgresPool } from "./postgres-runtime.server";

export const seededEvidenceDirectory =
  "C:\\Users\\Admin\\Desktop\\NEW\\smart-storage-probe-evidence";
export type SeededProbeManifests = {
  plan: unknown;
  review: unknown;
  authAuthorization: unknown;
  config: unknown;
  storageAuthorization: unknown;
};

/** Pure validation only. Planned scope is never passed to execution as registration. */
export function preflightSeededProbe(
  m: SeededProbeManifests,
  now = Date.now(),
) {
  const auth = preflightSeededFixtureAuthHost(
    m.plan,
    m.review,
    m.authAuthorization,
    now,
  );
  const config = disposableProbeConfigSchema.parse(m.config);
  const storage = disposableProbeAuthorizationSchema.parse(
    m.storageAuthorization,
  );
  if (
    auth.authorizationId === storage.authorizationId ||
    auth.evidenceDirectory !== seededEvidenceDirectory ||
    config.destinations.evidenceDirectory !== seededEvidenceDirectory ||
    auth.expiresAt <= now ||
    storage.expiresAt <= now
  )
    throw Error("SEEDED_COMPOSITION_REJECTED");
  const planned = seededFixtureSchema.parse({
    operation: "seeded-fixture-inspection",
    provenance: "externally-seeded-operator-fixture",
    registrationId: "00000000-0000-4000-8000-000000000000", // validation only
    ownerId: config.userId,
    project: config.project,
    bucket: config.bucket,
    path: config.key,
    declaredBytes: config.expectedBytes,
    expectedSha256: config.expectedSha256,
    verificationReference: config.independentFixtureVerification,
    expiresAt: storage.expiresAt,
  });
  const target = {
    project: config.project,
    endpoint: config.endpoint,
    prefix: "gateway-probe/v1",
    intent: planned,
    scope: {
      namespace: config.project,
      uploadId: null,
      version: null,
      generation: null,
    },
  };
  for (const kind of ["metadata", "hash", "list"])
    preflightDisposableProbe(
      config,
      storage,
      target,
      config.destinations,
      kind,
      now,
    );
  return { auth, config, storage };
}

type Pools = {
  administrator: GatewayPostgresPool;
  observer: GatewayPostgresPool;
  verify(): Promise<void>;
  close(): Promise<void>;
};
type AuthOptions = Parameters<typeof authenticateSeededFixtureHost>[0];
/** Dependency injection is internal testing/composition only; no caller UID input. */
export async function executeSeededProbe(
  m: SeededProbeManifests,
  io: {
    validateLocal(): Promise<void>;
    confirm(id: string, phase: "execution" | "registration"): Promise<boolean>;
    openPools(): Promise<Pools>;
    readMaskedCredentials: AuthOptions["readMaskedCredentials"];
  },
  dependencies = {
    authenticateProbeHost: authenticateSeededFixtureHost,
    registerSeededFixture,
    composeSeededFixtureProbe,
    fence: () => new FileProbeFence(seededEvidenceDirectory),
  },
) {
  const initial = preflightSeededProbe(m);
  await io.validateLocal();
  if (!(await io.confirm(initial.storage.authorizationId, "execution")))
    throw Error("CANCELLED");
  preflightSeededProbe(m);
  const pools = await io.openPools();
  let session: Awaited<ReturnType<typeof authenticateSeededFixtureHost>> | undefined;
  try {
    await pools.verify();
    preflightSeededProbe(m);
    session = await dependencies.authenticateProbeHost({
      plan: m.plan,
      review: m.review,
      authorization: m.authAuthorization,
      readMaskedCredentials: io.readMaskedCredentials,
      confirm: (id) => io.confirm(id, "execution"),
    });
    // The existing Auth host establishes this identity using authenticated GET /user.
    // Never derive trusted ownership from the plan, registration or object metadata.
    const verifiedSession = session;
    const trustedOwner = async () => {
      if (
        verifiedSession.expiresAt <= Date.now() ||
        verifiedSession.userId !== initial.config.userId
      )
        throw Error("VERIFIED_OWNER_REQUIRED");
      return verifiedSession.userId;
    };
    await trustedOwner();
    if (!(await io.confirm(initial.storage.authorizationId, "registration")))
      throw Error("CANCELLED");
    const current = preflightSeededProbe(m);
    const expiresAt = Math.min(
      current.auth.expiresAt,
      current.storage.expiresAt,
      session.expiresAt,
    );
    if (expiresAt - Date.now() < 120000)
      throw Error("INSUFFICIENT_EXECUTION_WINDOW");
    // Durable single attempt precedes registration, including uncertain COMMIT.
    await dependencies
      .fence()
      .claim(current.storage.authorizationId, "seeded-registration");
    preflightSeededProbe(m);
    const registrationId = await dependencies.registerSeededFixture(
      pools.administrator,
      {
        authorized: true,
        verificationReference: current.config.independentFixtureVerification,
        expiresAt,
      },
    );
    const composition = await dependencies.composeSeededFixtureProbe({
      observerPool: pools.observer,
      trustedOwner,
      registrationId,
      evidenceDirectory: seededEvidenceDirectory,
      restrictedAclReviewed: true,
    });
    for (const kind of ["metadata", "hash", "list"] as const) {
      preflightSeededProbe(m);
      const result = await session.runProbe(
        {
          ...composition,
          config: current.config,
          authorization: current.storage,
        },
        kind,
        randomUUID(),
        AbortSignal.timeout(30000),
      );
      // Runner persists ambiguous provider results instead of throwing them.
      if (
        result.direct.status === null ||
        result.direct.status < 200 ||
        result.direct.status >= 300 ||
        result.inference === "unknown" ||
        result.inference === "mismatch"
      )
        throw Error("PROBE_HALTED_PRESERVE_EVIDENCE");
    }
  } finally {
    session?.dispose();
    await pools.close();
  }
}
