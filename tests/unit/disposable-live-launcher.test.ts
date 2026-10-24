import { beforeEach, describe, expect, it, vi } from "vitest";
import template from "../../experiments/storage/disposable-upload.config.template.json";
import { prepareDisposableFixture } from "../../experiments/storage/disposable-roundtrip-executor";
import { disposableUploadTarget as target } from "../../experiments/storage/disposable-upload-contract";
const host = vi.hoisted(() => vi.fn());
vi.mock("../../experiments/storage/disposable-roundtrip-host", () => ({
  runOperatorRoundTrip: host,
}));
import { launchDisposableRoundTrip } from "../../experiments/storage/disposable-live-launcher";
import * as executor from "../../experiments/storage/disposable-roundtrip-executor";

const now = 1800000000000;
async function setup() {
  const { source, encoded, ...manifest } = await prepareDisposableFixture();
  const bucket = {
    id: target.bucket,
    name: target.bucket,
    public: false,
    file_size_limit: 65536,
    allowed_mime_types: ["application/octet-stream"] as string[] | null,
  };
  const evidence = {
    config: {
      ...template,
      ...manifest,
      enabled: true,
      fixtureVerificationReference: "synthetic",
      createReadPermissionReviewReference: "synthetic-permissions",
    },
    qualification: {
      claimDirectory: "C:\\SmartStorage-Upload-Claims",
      retentionAndPowerLossReview: "synthetic-retention",
      effectivePermissionsReview: "synthetic-permissions",
      ordinarySessionVerificationReview: "synthetic-auth",
    },
    bucket,
    absence: {
      project: target.project,
      bucket: target.bucket,
      key: target.key,
      exists: false,
      checkedAt: now,
      authoritativeReview: "synthetic-authoritative-query",
    },
    providerCompatibilityReview: "synthetic-compatibility",
    expiresAt: now + 60000,
  };
  const jwt = `e30.${Buffer.from(JSON.stringify({ sub: target.userId, role: "authenticated", iss: "https://rrylhvqalsxjnkdkpwde.supabase.co/auth/v1", aud: "authenticated", exp: now / 1000 + 3600 })).toString("base64url")}.signature`;
  const replies: unknown[] = [
    { access_token: jwt, token_type: "bearer", user: { id: target.userId } },
    { id: target.userId, role: "authenticated" },
    bucket,
    [],
  ];
  const transport = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(replies.shift()), { status: 200 }),
  );
  const answers = [
    "PREFLIGHT DISPOSABLE",
    "sb_publishable_synthetic",
    "test@example.invalid",
    "synthetic",
    "UPLOAD DISPOSABLE ONCE",
  ];
  const hidden = vi.fn(async () => answers.shift()!);
  return {
    source,
    encoded,
    evidence,
    transport,
    hidden,
    now: () => now,
    replies,
    answers,
  };
}
describe("disposable interactive launcher (offline only)", () => {
  const postgresReview = {
    claimRegistry: "postgresql-v1",
    project: target.project,
    deploymentReview: "synthetic",
    committedResponseReview: "synthetic",
    retentionAndPowerLossReview: "synthetic",
    privilegedRollbackAndRestoreReview: "synthetic",
    effectivePermissionsReview: "synthetic-permissions",
    ordinarySessionVerificationReview: "synthetic-auth",
  };
  it("routes PostgreSQL execution through existing executor without Windows claims", async () => {
    const x = await setup();
    const run = vi
      .spyOn(executor, "executeDisposableRoundTrip")
      .mockResolvedValue({
        verified: true,
        sourceBytes: 4736,
        encodedBytes: 89,
      });
    try {
      await launchDisposableRoundTrip({
        ...x,
        evidence: { ...x.evidence, qualification: postgresReview },
        mode: "--execute",
      });
      expect(host).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledTimes(1);
      expect(x.transport).toHaveBeenCalledTimes(4);
      expect(await run.mock.calls[0][0].session()).toMatchObject({
        userId: target.userId,
      });
      x.replies.push(true);
      expect(
        await run.mock.calls[0][0].claimOnce(
          `${target.project}/${target.bucket}/${target.key}/upload`,
        ),
      ).toBe(true);
      expect(x.transport).toHaveBeenCalledTimes(5);
    } finally {
      run.mockRestore();
    }
  });
  it("requires separate PostgreSQL rollback review before Auth; preflight never consumes claims", async () => {
    const x = await setup();
    await expect(
      launchDisposableRoundTrip({
        ...x,
        evidence: {
          ...x.evidence,
          qualification: {
            ...postgresReview,
            privilegedRollbackAndRestoreReview: "",
          },
        },
        mode: "--preflight",
      }),
    ).rejects.toThrow();
    expect(x.transport).not.toHaveBeenCalled();
    await launchDisposableRoundTrip({
      ...x,
      evidence: { ...x.evidence, qualification: postgresReview },
      mode: "--preflight",
    });
    expect(x.transport).toHaveBeenCalledTimes(4);
    expect(host).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    host.mockReset();
    host.mockResolvedValue({ verified: true });
  });
  it("accepts explicitly unrestricted MIME evidence and metadata without executing the host", async () => {
    const x = await setup();
    x.evidence.bucket.allowed_mime_types = null;
    await expect(
      launchDisposableRoundTrip({ ...x, mode: "--preflight" }),
    ).resolves.toEqual({ preflight: true });
    expect(x.transport).toHaveBeenCalledTimes(4);
    expect(host).not.toHaveBeenCalled();
  });
  it.each(["restricted", "unrestricted"])(
    "rejects MIME configuration drift from %s evidence",
    async (kind) => {
      const x = await setup();
      if (kind === "unrestricted") x.evidence.bucket.allowed_mime_types = null;
      x.replies[2] = {
        ...x.evidence.bucket,
        allowed_mime_types:
          kind === "restricted" ? null : ["application/octet-stream"],
      };
      await expect(
        launchDisposableRoundTrip({ ...x, mode: "--execute" }),
      ).rejects.toThrow("UNEXPECTED_BUCKET_CONFIGURATION");
      expect(x.transport).toHaveBeenCalledTimes(3);
      expect(host).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, [], "null", {}, [null]].map((value) => ({ value })))(
    "rejects ambiguous MIME evidence %j before Auth",
    async ({ value }) => {
      const x = await setup();
      const evidence = {
        ...x.evidence,
        bucket: { ...x.evidence.bucket, allowed_mime_types: value },
      };
      await expect(
        launchDisposableRoundTrip({ ...x, evidence, mode: "--execute" }),
      ).rejects.toThrow();
      expect(x.transport).not.toHaveBeenCalled();
      expect(host).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, [], "null", {}, [null]].map((value) => ({ value })))(
    "rejects ambiguous MIME metadata %j after ordinary Auth",
    async ({ value }) => {
      const x = await setup();
      x.evidence.bucket.allowed_mime_types = null;
      x.replies[2] = { ...x.evidence.bucket, allowed_mime_types: value };
      await expect(
        launchDisposableRoundTrip({ ...x, mode: "--execute" }),
      ).rejects.toThrow();
      expect(x.transport).toHaveBeenCalledTimes(3);
      expect(host).not.toHaveBeenCalled();
    },
  );
  it("read-only preflight uses one ordinary login and only bucket/list metadata; never calls host", async () => {
    const x = await setup();
    await expect(
      launchDisposableRoundTrip({ ...x, mode: "--preflight" }),
    ).resolves.toEqual({ preflight: true });
    expect(host).not.toHaveBeenCalled();
    expect(x.transport.mock.calls).toHaveLength(4);
    expect(
      x.transport.mock.calls.map(([url, init]) => [url, init?.method]),
    ).toEqual([
      [
        "https://rrylhvqalsxjnkdkpwde.supabase.co/auth/v1/token?grant_type=password",
        "POST",
      ],
      ["https://rrylhvqalsxjnkdkpwde.supabase.co/auth/v1/user", "GET"],
      [`${target.endpoint}/bucket/${target.bucket}`, "GET"],
      [`${target.endpoint}/object/list/${target.bucket}`, "POST"],
    ]);
    const list = x.transport.mock.calls[3][1]!;
    expect(JSON.parse(list.body as string)).toEqual({
      prefix: "practice-roundtrip/20261019",
      search: "compressed-test-001.bin",
      limit: 2,
      offset: 0,
    });
    expect(list.redirect).toBe("error");
  });
  it("hands same verified in-memory bearer and exact claims path to host only after separate confirmation", async () => {
    const x = await setup();
    await launchDisposableRoundTrip({ ...x, mode: "--execute" });
    expect(x.hidden).toHaveBeenCalledTimes(5);
    const args = host.mock.calls[0][0];
    expect(args.qualification.claimDirectory).toBe(
      "C:\\SmartStorage-Upload-Claims",
    );
    expect((await args.verifiedSession()).userId).toBe(target.userId);
    expect(args.authorization).toMatchObject({
      project: target.project,
      key: target.key,
      upload: 1,
      download: 1,
    });
  });
  it.each([
    "expired",
    "stale absence",
    "future absence",
    "wrong project",
    "wrong directory",
    "missing permissions",
    "bad MIME",
    "bad fixture",
  ])("rejects %s before Auth", async (reason) => {
    const x = await setup();
    if (reason === "expired") x.evidence.expiresAt = now;
    if (reason === "stale absence") x.evidence.absence.checkedAt = now - 120001;
    if (reason === "future absence") x.evidence.absence.checkedAt = now + 1;
    if (reason === "wrong project") x.evidence.config.project = "protected";
    if (reason === "wrong directory")
      x.evidence.qualification.claimDirectory = "C:\\other";
    if (reason === "missing permissions")
      x.evidence.qualification.effectivePermissionsReview = "";
    if (reason === "bad MIME")
      x.evidence.bucket.allowed_mime_types = ["text/plain"];
    if (reason === "bad fixture") x.encoded[0] ^= 1;
    await expect(
      launchDisposableRoundTrip({ ...x, mode: "--execute" }),
    ).rejects.toThrow();
    expect(x.transport).not.toHaveBeenCalled();
    expect(host).not.toHaveBeenCalled();
  });
  it.each([
    "cancel preflight",
    "cancel live",
    "privileged",
    "wrong user",
    "public bucket",
    "bucket drift",
    "existing key",
    "ambiguous list",
    "network",
    "denied",
    "Storage denied",
    "Storage redirect",
    "oversized",
    "malformed",
    "expired after confirmation",
  ])("halts on %s without host or retry", async (reason) => {
    const x = await setup();
    if (reason === "cancel preflight") x.answers[0] = "no";
    if (reason === "cancel live") x.answers[4] = "no";
    if (reason === "privileged") x.answers[1] = "sb_secret_synthetic";
    if (reason === "wrong user")
      x.replies[1] = { id: "other", role: "authenticated" };
    if (reason === "public bucket")
      x.replies[2] = { ...x.evidence.bucket, public: true };
    if (reason === "bucket drift")
      x.replies[2] = { ...x.evidence.bucket, file_size_limit: 999 };
    if (reason === "existing key")
      x.replies[3] = [{ name: "compressed-test-001.bin" }] as never;
    if (reason === "ambiguous list") x.replies[3] = {} as never;
    if (reason === "network")
      x.transport.mockRejectedValueOnce(Error("private provider error"));
    if (reason === "denied")
      x.transport.mockResolvedValueOnce(
        new Response("denied", { status: 403 }),
      );
    if (
      ["oversized", "malformed", "Storage denied", "Storage redirect"].includes(
        reason,
      )
    ) {
      const original = x.transport.getMockImplementation()!;
      let n = 0;
      x.transport.mockImplementation(async (...args) =>
        ++n === 3
          ? new Response(reason === "oversized" ? "x".repeat(65537) : "{", {
              status:
                reason === "Storage denied"
                  ? 403
                  : reason === "Storage redirect"
                    ? 302
                    : 200,
            })
          : original(...args),
      );
    }
    let clock = now;
    if (reason === "expired after confirmation") {
      x.now = () => clock;
      const original = x.hidden.getMockImplementation()!;
      x.hidden.mockImplementation(async () => {
        const answer = await original();
        if (answer === "UPLOAD DISPOSABLE ONCE") clock += 60001;
        return answer;
      });
    }
    await expect(
      launchDisposableRoundTrip({ ...x, mode: "--execute" }),
    ).rejects.toThrow();
    expect(host).not.toHaveBeenCalled();
    expect(x.transport.mock.calls.length).toBeLessThanOrEqual(4);
  });
});
