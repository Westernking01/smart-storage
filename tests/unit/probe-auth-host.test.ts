import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  authenticateProbeHost,
  authenticateSeededFixtureHost,
} from "../../src/lib/gateway/probe-auth-host.server";
import type { ProbeTarget } from "../../src/lib/gateway/inspection-runner.server";
const load = (name: string) =>
  JSON.parse(
    readFileSync(
      `experiments/storage/disposable-probe.${name}.template.json`,
      "utf8",
    ),
  );
const plan = load("auth");
const review = Object.fromEntries(
  Object.entries(load("permissions")).map(([k, v]) => [
    k,
    v === false ? true : k === "reviewReference" ? "mock review" : v,
  ]),
);
const approval = {
  ...load("auth-authorization"),
  enabled: true,
  authorizationId: "00000000-0000-4000-8000-000000000001",
  issuedAt: 1000,
  expiresAt: 1800000,
  physicalOverheadUnboundedAcknowledged: true,
  evidenceDirectory: "C:\\private\\probe",
  restrictedAclReviewed: true,
};
const uid = approval.userId;
const issuer = approval.authEndpoint;
function token(patch = {}) {
  return [
    "e30",
    Buffer.from(
      JSON.stringify({
        iss: issuer,
        sub: uid,
        role: "authenticated",
        aud: "authenticated",
        exp: 3600,
        ...patch,
      }),
    ).toString("base64url"),
    "mock-signature",
  ].join(".");
}
function fixture() {
  let time = 2000;
  const claims = new Set<string>();
  const fence = {
    claim: vi.fn(async (id: string, kind: string) => {
      const key = id + kind;
      if (claims.has(key)) throw Error("CONSUMED");
      claims.add(key);
    }),
  };
  const http = vi.fn(async (url: string, init: RequestInit) => {
    void init;
    return new Response(
      JSON.stringify(
        url.endsWith("/user")
          ? { id: uid, role: "authenticated" }
          : {
              access_token: token(),
              refresh_token: "never-persist",
              token_type: "bearer",
              user: { id: uid },
            },
      ),
    );
  });
  const input = vi.fn(async () => ({
    apiKey: "sb_publishable_mockonly123",
    email: "fixture@example.invalid",
    password: "mock-password",
  }));
  const confirm = vi.fn(async () => true);
  const run = (patch = {}) =>
    authenticateProbeHost({
      plan,
      review,
      authorization: approval,
      readMaskedCredentials: input,
      confirm,
      http,
      fence,
      now: () => time,
      ...patch,
    });
  return {
    run,
    http,
    input,
    fence,
    confirm,
    setTime: (v: number) => {
      time = v;
    },
  };
}
describe("executable memory-only probe authentication host", () => {
  it("uses the seeded review through real Auth control flow with mocked HTTP only", async () => {
    const f = fixture();
    const seeded = {
      ...JSON.parse(
        readFileSync(
          "experiments/storage/seeded-fixture.permissions.template.json",
          "utf8",
        ),
      ),
      reviewReference: "existing-record#policyReview",
      checkedRoleMembershipsReviewed: true,
      reportedSelectBoundaryReviewed: true,
      reportedMutationPolicyAbsenceReviewed: true,
    };
    await expect(f.run({ review: seeded })).rejects.toThrow();
    expect(f.input).not.toHaveBeenCalled();
    const session = await authenticateSeededFixtureHost({
      plan,
      review: seeded,
      authorization: approval,
      readMaskedCredentials: f.input,
      confirm: f.confirm,
      http: f.http,
      fence: f.fence,
      now: () => 2000,
    });
    try {
      expect(session.userId).toBe(uid);
      expect(f.http).toHaveBeenCalledTimes(2);
      expect(f.fence.claim).toHaveBeenCalledOnce();
    } finally {
      session.dispose();
    }
  });
  it("hands verified in-memory credentials to the guarded probe and retains provisional holds", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(2000);
    const f = fixture();
    const probeHttp = vi.fn(async () => new Response("abc"));
    const session = await f.run({ probeHttp });
    try {
      const destinations = {
        observer: "postgresql://127.0.0.1:5432/smart_storage_gateway_test",
        observerRole: "ss_gateway_observer_runtime_test",
        evidenceDirectory: "C:\\private\\probe",
        restrictedAclReviewed: true,
      };
      const config = {
        ...load("config"),
        enabled: true,
        expectedBytes: 3,
        expectedSha256: createHash("sha256").update("abc").digest("hex"),
        independentFixtureVerification: "mock source record",
        destinations,
      };
      const authorization = {
        ...load("authorization"),
        ...config,
        authorizationId: approval.authorizationId,
        issuedAt: 1000,
        expiresAt: 61000,
        physicalOverheadUnboundedAcknowledged: true,
      };
      delete authorization.enabled;
      const id = approval.authorizationId;
      const target: ProbeTarget = {
        project: config.project,
        endpoint: config.endpoint,
        prefix: "gateway-probe/v1",
        scope: {
          namespace: "mock",
          uploadId: null,
          version: null,
          generation: null,
        },
        intent: {
          ownerId: uid,
          executorId: id,
          requestId: id,
          resourceId: id,
          sessionId: id,
          fileId: id,
          attemptId: id,
          epoch: 1,
          dispatchGeneration: 1,
          bucket: config.bucket,
          path: config.key,
          declaredBytes: 3,
          expectedSha256: config.expectedSha256,
          operation: "single-object-create",
        },
      };
      const append = vi.fn(async () => {});
      const p = {
        config,
        authorization,
        target,
        destinations,
        sink: { append },
        fence: f.fence,
      };
      const result = await session.runProbe(
        p,
        "hash",
        id,
        new AbortController().signal,
      );
      expect(result).toMatchObject({
        inference: "matches",
        retainHolds: true,
        certified: false,
      });
      expect(append).toHaveBeenCalledTimes(2);
      expect(probeHttp).toHaveBeenCalledTimes(1);
      await expect(
        session.runProbe(p, "hash", id, new AbortController().signal),
      ).rejects.toThrow();
      expect(probeHttp).toHaveBeenCalledTimes(1);
      session.dispose();
      await expect(
        session.runProbe(p, "metadata", id, new AbortController().signal),
      ).rejects.toThrow("AUTH_SESSION_EXPIRED");
      expect(probeHttp).toHaveBeenCalledTimes(1);
    } finally {
      session.dispose();
      clock.mockRestore();
    }
  });
  it("signs in once, verifies once, exposes no token/session and clears on disposal", async () => {
    const f = fixture();
    const session = await f.run();
    expect(f.http).toHaveBeenCalledTimes(2);
    expect(f.http.mock.calls.map((c) => c[0])).toEqual([
      issuer + "/token?grant_type=password",
      issuer + "/user",
    ]);
    expect(f.http.mock.calls[0][1]).toMatchObject({
      method: "POST",
      redirect: "error",
    });
    expect(f.http.mock.calls[1][1]).toMatchObject({
      method: "GET",
      redirect: "error",
    });
    expect(JSON.stringify(session)).not.toMatch(
      /mock-password|access_token|refresh_token|mock-signature/,
    );
    session.dispose();
    expect(f.http).toHaveBeenCalledTimes(2);
    await expect(f.run()).rejects.toThrow("PROBE_AUTH_FAILED_CLOSED");
    expect(f.input).toHaveBeenCalledTimes(1);
  });
  it.each([
    { enabled: false },
    { project: "fneuqneqaopkmpeevlqz" },
    { expiresAt: 2000 },
    { authEndpoint: "https://example.invalid/auth/v1" },
    { userId: "wrong" },
    { operations: { passwordSignIn: 2, identityVerification: 1 } },
    { physicalOverheadUnboundedAcknowledged: false },
    { retries: 1 },
    { redirects: 1 },
    { restrictedAclReviewed: false },
    { password: "unexpected" },
  ])(
    "rejects authority before confirmation, fence, secrets or HTTP %j",
    async (patch) => {
      const f = fixture();
      await expect(
        f.run({ authorization: { ...approval, ...patch } }),
      ).rejects.toThrow();
      expect(f.confirm).not.toHaveBeenCalled();
      expect(f.fence.claim).not.toHaveBeenCalled();
      expect(f.input).not.toHaveBeenCalled();
      expect(f.http).not.toHaveBeenCalled();
    },
  );
  it("requires human confirmation before consuming approval", async () => {
    const f = fixture();
    f.confirm.mockResolvedValue(false);
    await expect(f.run()).rejects.toThrow();
    expect(f.input).not.toHaveBeenCalled();
    expect(f.fence.claim).not.toHaveBeenCalled();
  });
  it("rechecks expiry after input and never dispatches expired authorization", async () => {
    const f = fixture();
    f.input.mockImplementation(async () => {
      f.setTime(1800000);
      return {
        apiKey: "sb_publishable_mockonly123",
        email: "x",
        password: "y",
      };
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.http).not.toHaveBeenCalled();
  });
  it("consumes ambiguous sign-in without identity or retry and redacts errors", async () => {
    const f = fixture();
    f.http.mockRejectedValue(Error("mock-password mock-signature"));
    await expect(f.run()).rejects.toThrow(/^PROBE_AUTH_FAILED_CLOSED$/);
    await expect(f.run()).rejects.toThrow();
    expect(f.http).toHaveBeenCalledTimes(1);
  });
  it.each([
    { iss: "https://fneuqneqaopkmpeevlqz.supabase.co/auth/v1" },
    { sub: "wrong" },
    { role: "service_role" },
    { aud: "wrong" },
    { exp: 121 },
  ])(
    "rejects token sanity mismatch without identity dispatch %j",
    async (patch) => {
      const f = fixture();
      f.http.mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: token(patch),
            token_type: "bearer",
            user: { id: uid },
          }),
        ),
      );
      await expect(f.run()).rejects.toThrow();
      expect(f.http).toHaveBeenCalledTimes(1);
    },
  );
  it("requires verified identity, not just decoded claims", async () => {
    const f = fixture();
    f.http
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: token(),
            token_type: "bearer",
            user: { id: uid },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "wrong", role: "authenticated" })),
      );
    await expect(f.run()).rejects.toThrow();
    expect(f.http).toHaveBeenCalledTimes(2);
  });
  it("rejects administrative API keys before dispatch", async () => {
    const f = fixture();
    f.input.mockResolvedValue({
      apiKey: "sb_secret_forbidden",
      email: "x",
      password: "y",
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.http).not.toHaveBeenCalled();
  });
  it("leaves the integrated Storage probe disabled", async () => {
    const f = fixture();
    const session = await f.run();
    await expect(
      session.runProbe(
        {
          config: load("config"),
          authorization: load("authorization"),
          target: {} as ProbeTarget,
          destinations: {},
          sink: { append: vi.fn() },
          fence: f.fence,
        },
        "hash",
        "unused",
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(f.http).toHaveBeenCalledTimes(2);
    session.dispose();
  });
});
