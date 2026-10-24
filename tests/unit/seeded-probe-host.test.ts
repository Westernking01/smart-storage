import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  executeSeededProbe,
  preflightSeededProbe,
  seededEvidenceDirectory,
} from "../../src/lib/gateway/seeded-probe-host.server";
import type { GatewayPostgresPool } from "../../src/lib/gateway/postgres-runtime.server";
const load = (name: string) =>
  JSON.parse(
    readFileSync(
      `experiments/storage/disposable-probe.${name}.template.json`,
      "utf8",
    ),
  );
function setup() {
  const now = Date.now();
  const config = {
    ...load("config"),
    enabled: true,
    independentFixtureVerification: "independent-source-record",
    destinations: {
      ...load("config").destinations,
      evidenceDirectory: seededEvidenceDirectory,
      restrictedAclReviewed: true,
    },
  };
  const m = {
    plan: load("auth"),
    review: Object.fromEntries(
      Object.entries(
        JSON.parse(
          readFileSync(
            "experiments/storage/seeded-fixture.permissions.template.json",
            "utf8",
          ),
        ),
      ).map(([k, v]) => [
        k,
        v === false ? true : k === "reviewReference" ? "policy-record" : v,
      ]),
    ),
    authAuthorization: {
      ...load("auth-authorization"),
      enabled: true,
      authorizationId: "10000000-0000-4000-8000-000000000001",
      issuedAt: now,
      expiresAt: now + 1200000,
      physicalOverheadUnboundedAcknowledged: true,
      evidenceDirectory: seededEvidenceDirectory,
      restrictedAclReviewed: true,
    },
    config,
    storageAuthorization: {
      ...load("authorization"),
      ...config,
      enabled: undefined,
      authorizationId: "20000000-0000-4000-8000-000000000002",
      issuedAt: now,
      expiresAt: now + 1200000,
      physicalOverheadUnboundedAcknowledged: true,
    },
  };
  delete m.storageAuthorization.enabled;
  const events: string[] = [];
  const pool: GatewayPostgresPool = {
    connect: vi.fn(async () => {
      throw Error("NO_DATABASE");
    }),
  };
  const session = {
    userId: config.userId,
    expiresAt: now + 1200000,
    dispose: vi.fn(() => {
      events.push("dispose");
    }),
    runProbe: vi.fn(async (_p: unknown, kind: string) => {
      events.push(kind);
      return {
        direct: { status: 200 },
        inference: kind === "list" ? "incomplete" : "matches",
      };
    }),
  };
  const io = {
    validateLocal: vi.fn(async () => {
      events.push("local");
    }),
    confirm: vi.fn(async (_id: string, phase: string) => {
      events.push(phase);
      return true;
    }),
    readMaskedCredentials: vi.fn(async () => ({
      apiKey: "mock",
      email: "mock",
      password: "mock",
    })),
    openPools: vi.fn(async () => ({
      administrator: pool,
      observer: pool,
      verify: async () => {
        events.push("verify-pools");
      },
      close: async () => {
        events.push("close");
      },
    })),
  };
  const dependencies = {
    authenticateProbeHost: vi.fn(async () => {
      events.push("auth");
      return session;
    }),
    registerSeededFixture: vi.fn(async () => {
      events.push("register");
      return "30000000-0000-4000-8000-000000000003";
    }),
    composeSeededFixtureProbe: vi.fn(
      async (options: { trustedOwner: () => Promise<string> }) => {
        expect(await options.trustedOwner()).toBe(session.userId);
        events.push("compose");
        return {};
      },
    ),
    fence: () => ({
      claim: vi.fn(async () => {
        events.push("claim-registration");
      }),
    }),
  };
  // Real interfaces are narrower than intentionally minimal execution-result mocks.
  const run = () =>
    executeSeededProbe(
      m,
      io,
      dependencies as unknown as NonNullable<
        Parameters<typeof executeSeededProbe>[2]
      >,
    );
  return { m, io, dependencies, session, events, run };
}
describe("single-process seeded probe host (offline mocked boundaries)", () => {
  it("validates offline without acquiring any authority", () => {
    const f = setup();
    preflightSeededProbe(f.m);
    expect(f.events).toEqual([]);
    expect(f.io.openPools).not.toHaveBeenCalled();
  });
  it.each(["restrictedAclReviewed", "physicalOverheadUnboundedAcknowledged"])(
    "retains Auth acknowledgment %s",
    async (field) => {
      const f = setup();
      f.m.authAuthorization[field] = false;
      await expect(f.run()).rejects.toThrow();
      expect(f.events).toEqual([]);
    },
  );
  it("does not accept the broader review as a seeded configuration review", () => {
    const f = setup();
    f.m.review = {
      ...load("permissions"),
      noBroaderEffectiveAccess: true,
      noWriteOrAdministrativeAccess: true,
      reviewReference: "record",
    };
    expect(() => preflightSeededProbe(f.m)).toThrow();
  });
  it.each([
    "wrong-project",
    "wrong-hash",
    "bad-policy",
    "wrong-directory",
    "expired",
    "disabled",
    "extra-operation",
  ])("rejects %s before local I/O or credentials", async (kind) => {
    const f = setup();
    if (kind === "wrong-project") f.m.config.project = "fneuqneqaopkmpeevlqz";
    if (kind === "wrong-hash") f.m.config.expectedSha256 = "0".repeat(64);
    if (kind === "bad-policy")
      f.m.review.reportedSelectBoundaryReviewed = false;
    if (kind === "wrong-directory")
      f.m.config.destinations.evidenceDirectory = "C:\\other";
    if (kind === "expired") f.m.authAuthorization.expiresAt = Date.now() - 1;
    if (kind === "disabled") f.m.config.enabled = false;
    if (kind === "extra-operation")
      f.m.storageAuthorization.operations.upload = 1;
    await expect(f.run()).rejects.toThrow();
    expect(f.events).toEqual([]);
  });
  it("orders confirmations, one verified session, one registration and only three reads", async () => {
    const f = setup();
    await f.run();
    expect(f.events).toEqual([
      "local",
      "execution",
      "verify-pools",
      "auth",
      "registration",
      "claim-registration",
      "register",
      "compose",
      "metadata",
      "hash",
      "list",
      "dispose",
      "close",
    ]);
    expect(f.dependencies.authenticateProbeHost).toHaveBeenCalledTimes(1);
    expect(f.dependencies.registerSeededFixture).toHaveBeenCalledTimes(1);
    expect(f.session.runProbe).toHaveBeenCalledTimes(3);
  });
  it("refuses unverified/wrong session owner before registration", async () => {
    const f = setup();
    f.session.userId = "40000000-0000-4000-8000-000000000004";
    await expect(f.run()).rejects.toThrow("VERIFIED_OWNER_REQUIRED");
    expect(f.dependencies.registerSeededFixture).not.toHaveBeenCalled();
    expect(f.session.dispose).toHaveBeenCalledOnce();
  });
  it("does not register on cancelled second confirmation", async () => {
    const f = setup();
    f.io.confirm.mockImplementation(
      async (_id, phase) => phase !== "registration",
    );
    await expect(f.run()).rejects.toThrow();
    expect(f.dependencies.registerSeededFixture).not.toHaveBeenCalled();
    expect(f.session.dispose).toHaveBeenCalledOnce();
    expect(f.events.at(-1)).toBe("close");
  });
  it("preserves failed/ambiguous registration without replay and disposes session", async () => {
    const f = setup();
    f.dependencies.registerSeededFixture.mockRejectedValue(
      Error("LOST_COMMIT_ACK"),
    );
    await expect(f.run()).rejects.toThrow();
    expect(f.dependencies.registerSeededFixture).toHaveBeenCalledOnce();
    expect(f.session.runProbe).not.toHaveBeenCalled();
    expect(f.session.dispose).toHaveBeenCalledOnce();
  });
  it("halts after ambiguous provider receipt, even when runner resolves", async () => {
    const f = setup();
    f.session.runProbe.mockResolvedValue({
      direct: { status: 200 },
      inference: "unknown",
    });
    await expect(f.run()).rejects.toThrow("PROBE_HALTED");
    expect(f.session.runProbe).toHaveBeenCalledOnce();
    expect(f.session.dispose).toHaveBeenCalledOnce();
  });
  it("closes pools on Auth failure and never registers", async () => {
    const f = setup();
    f.dependencies.authenticateProbeHost.mockRejectedValue(
      Error("AUTH_FAILURE"),
    );
    await expect(f.run()).rejects.toThrow();
    expect(f.events.at(-1)).toBe("close");
    expect(f.dependencies.registerSeededFixture).not.toHaveBeenCalled();
  });
  it("rejects failed independent pool verification before Auth", async () => {
    const f = setup();
    const close = vi.fn(async () => {});
    f.io.openPools.mockResolvedValue({
      administrator: {} as GatewayPostgresPool,
      observer: {} as GatewayPostgresPool,
      verify: async () => {
        throw Error("WRONG_LOCAL_IDENTITY");
      },
      close,
    });
    await expect(f.run()).rejects.toThrow("WRONG_LOCAL_IDENTITY");
    expect(f.dependencies.authenticateProbeHost).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it("never registers after an already consumed durable claim", async () => {
    const f = setup();
    f.dependencies.fence = () => ({
      claim: vi.fn(async () => {
        throw Error("CONSUMED");
      }),
    });
    await expect(f.run()).rejects.toThrow("CONSUMED");
    expect(f.dependencies.registerSeededFixture).not.toHaveBeenCalled();
    expect(f.session.dispose).toHaveBeenCalledOnce();
  });
  it("rechecks expiry after interactive registration confirmation", async () => {
    const f = setup();
    f.io.confirm.mockImplementation(async (_id, phase) => {
      if (phase === "registration")
        f.m.storageAuthorization.expiresAt = Date.now() - 1;
      return true;
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.dependencies.registerSeededFixture).not.toHaveBeenCalled();
    expect(f.session.dispose).toHaveBeenCalledOnce();
  });
  it("does not acquire credentials when initial execution is cancelled", async () => {
    const f = setup();
    f.io.confirm.mockResolvedValue(false);
    await expect(f.run()).rejects.toThrow("CANCELLED");
    expect(f.io.openPools).not.toHaveBeenCalled();
    expect(f.io.readMaskedCredentials).not.toHaveBeenCalled();
  });
  it("halts before authority when local ACL validation fails", async () => {
    const f = setup();
    f.io.validateLocal.mockRejectedValue(Error("ACL"));
    await expect(f.run()).rejects.toThrow();
    expect(f.io.openPools).not.toHaveBeenCalled();
  });
});
