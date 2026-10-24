import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  Ledger,
  outsideRepository,
  type Codec,
  type DenialReconciliation,
} from "./ledger.js";
import { isCrossReadDenial, parseProviderError } from "./denial.js";
import {
  Runner,
  dryRun,
  summary,
  safeError,
  type Transport,
} from "./runner.js";
import {
  approve,
  boundResource,
  BUCKET,
  PROJECT,
  RUN,
  USERS,
  MANIFEST_HASH,
  MAX_BYTES,
  MAX_ALLOCATIONS,
  PATHS,
  STAGES,
  TUS_BYTES,
  fixture,
  hash,
  slot,
  validateIntent,
  type Approval,
  type Intent,
} from "./manifest.js";
import { ProviderHttp } from "./transport.js";
import { assertContinuation, continuationCheckpoint } from "./continuation.js";
import { usableSession, sessionLifetime } from "./session.js";
import {
  renewalCandidate,
  confirmSecondRenewal,
  renewSessions,
  NativeRenewalHttp,
  type RenewalTransport,
} from "./renewal.js";
import { renewalBytes } from "./renewal-evidence.js";
import { renewalDiagnostic } from "./renewal-diagnostic.js";
import { runCli } from "./cli.js";
import {
  continuationCandidate,
  confirmContinuation,
  CONTINUATION_PROMPT,
  invokePrivateContinuation,
  continuationResult,
} from "./continuation-helper.js";
function testToken(actor: "A" | "B", expired = false) {
  return `fixture.${Buffer.from(JSON.stringify({ role: "authenticated", sub: USERS[actor].id, exp: Math.floor(Date.now() / 1000) + (expired ? -72000 : 3600) })).toString("base64url")}.signature`;
}

const directories: string[] = [];
const ledgers: Ledger[] = [];
function codec(): Codec {
  const key = randomBytes(32);
  return {
    encode: (text) => {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([c.update(text), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
    },
    decode: (data) => {
      const b = Buffer.from(data, "base64");
      const c = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      c.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([c.update(b.subarray(28)), c.final()]).toString(
        "utf8",
      );
    },
  };
}
function state(fault?: (point: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "smart-storage-runner-test-"));
  directories.push(dir);
  const cipher = codec();
  const ledger = new Ledger(dir, cipher, fault);
  ledger.initialize();
  ledger.acquire();
  ledger.load();
  ledgers.push(ledger);
  ledger.update((s) => {
    s.sessions.A = { token: testToken("A"), verified: true };
    s.sessions.B = { token: testToken("B"), verified: true };
  });
  return { ledger, dir, cipher };
}
function permission(cleanup = false): Approval {
  return {
    kind: cleanup ? "storage-provider-cleanup" : "storage-provider-execution",
    id: "unit-test-approval-only",
    project: PROJECT,
    bucket: BUCKET,
    run: RUN,
    manifestHash: MANIFEST_HASH,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    purposes: cleanup
      ? ["cleanup"]
      : [
          "login",
          "identity",
          "rest-upload",
          "download",
          "cross-read",
          "wrong-owner-upload",
          "anonymous-read",
          "tus-create",
          "tus-head",
          "tus-part",
          "owner-info",
        ],
    acknowledgedRuntimeUncertainties: true,
  };
}
const upload = (): Intent => ({
  id: "rest-A",
  actor: "A",
  purpose: "rest-upload",
  method: "POST",
  path: slot(0),
  body: fixture(256),
  expected: "allow",
});
function runner(ledger: Ledger, send: Transport["send"]) {
  const p = ledger.isReconciled("cross-read-B")
    ? continuationPermission(ledger)
    : permission();
  return new Runner(ledger, { send }, p, p.id, false);
}
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("PROVIDER_NETWORK_FORBIDDEN_IN_TESTS");
    }),
  );
});
afterEach(() => {
  for (const l of ledgers.splice(0)) {
    try {
      l.release();
    } catch {
      /* temp fixture cleanup only */
    }
  }
  for (const dir of directories.splice(0)) {
    const absolute = resolve(dir);
    const allowed = resolve(tmpdir()) + sep + "smart-storage-runner-test-";
    if (!absolute.startsWith(allowed))
      throw new Error("UNSAFE_FIXTURE_CLEANUP_PATH");
    rmSync(absolute, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});

describe("durable budget and locking", () => {
  it("persists the reservation before the mocked transport and never retries allocations", async () => {
    const { ledger, dir, cipher } = state();
    const send = vi.fn(async () => {
      const last = JSON.parse(
        readFileSync(join(dir, "journal"), "utf8").trim().split("\n").at(-1)!,
      );
      const saved = JSON.parse(cipher.decode(last.cipher));
      expect(saved.allocations).toBe(1);
      expect(saved.bytes).toBe(256);
      expect(saved.entries[0].state).toBe("reserved");
      return { status: 200 };
    });
    const r = runner(ledger, send);
    await r.send(upload());
    await expect(r.send(upload())).rejects.toThrow(
      "DUPLICATE_ATTEMPT_NO_RETRY",
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(ledger.state.allocations).toBe(1);
  });
  it("counts exactly twelve attempted allocations including a repeated path, then blocks thirteen", () => {
    const { ledger } = state();
    for (let i = 0; i < MAX_ALLOCATIONS; i++) {
      const e = ledger.reserve(
        { ...upload(), id: `local-budget-${i}`, body: new Uint8Array(0) },
        true,
      );
      ledger.update((s) => {
        s.entries[e.sequence - 1].state = "failed";
      });
    }
    expect(() =>
      ledger.reserve({ ...upload(), id: "thirteenth" }, true),
    ).toThrow("EXPERIMENT_BUDGET_EXHAUSTED");
    expect(ledger.state.allocations).toBe(12);
  });
  it("counts all bodies including non-allocating requests and blocks exceeding 32 MiB", () => {
    const { ledger } = state();
    for (let i = 0; i < 4; i++) {
      const e = ledger.reserve(
        {
          ...upload(),
          id: `byte-budget-${i}`,
          body: new Uint8Array(MAX_BYTES / 4),
        },
        false,
      );
      ledger.update((s) => {
        s.entries[e.sequence - 1].state = "failed";
      });
    }
    expect(() =>
      ledger.reserve(
        { ...upload(), id: "extra-byte", body: new Uint8Array(1) },
        true,
      ),
    ).toThrow("EXPERIMENT_BUDGET_EXHAUSTED");
    expect(ledger.state.allocations).toBe(0);
    expect(ledger.state.bytes).toBe(MAX_BYTES);
  });
  it("fails closed after interrupted WAL/snapshot commit and never transmits", async () => {
    let interrupted = false;
    const { ledger, dir, cipher } = state((point) => {
      if (interrupted && point === "before-snapshot-rename")
        throw new Error("SIMULATED_INTERRUPTION");
    });
    interrupted = true;
    const send = vi.fn(async () => ({ status: 200 }));
    await expect(runner(ledger, send).send(upload())).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    const latest = JSON.parse(
      readFileSync(join(dir, "journal"), "utf8").trim().split("\n").at(-1)!,
    );
    expect(JSON.parse(cipher.decode(latest.cipher)).bytes).toBe(256);
    ledger.release();
    const resumed = new Ledger(dir, cipher);
    resumed.acquire();
    ledgers.push(resumed);
    expect(() => resumed.load()).toThrow("LEDGER_INTEGRITY_RECOVERY_REQUIRED");
    expect(() => resumed.initialize()).toThrow("LEDGER_ALREADY_INITIALIZED");
  });
  it("rejects partial journal and snapshot mismatch rather than resetting counters", () => {
    const { ledger, dir } = state();
    appendFileSync(join(dir, "journal"), '{"partial":');
    expect(() => ledger.load()).toThrow("LEDGER_INTEGRITY_RECOVERY_REQUIRED");
  });
  it("detects encrypted ledger corruption", () => {
    const { ledger, dir } = state();
    writeFileSync(join(dir, "snapshot"), "corrupt");
    expect(() => ledger.load()).toThrow("LEDGER_INTEGRITY_RECOVERY_REQUIRED");
  });
  it("blocks a second process from taking the same lock", () => {
    const { dir } = state();
    const result = execFileSync(
      process.execPath,
      [
        "-e",
        "const fs=require('node:fs');try{fs.openSync(require('node:path').join(process.argv[1],'lock'),'wx');process.exit(2)}catch(e){if(e.code!=='EEXIST')process.exit(3);process.stdout.write('LOCKED')}",
        dir,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    expect(result).toBe("LOCKED");
  });
  it("retains ambiguous attempted bytes and allocations across restart", async () => {
    const { ledger, dir, cipher } = state();
    await expect(
      runner(ledger, async () => {
        throw new Error("lost response with SECRET_URL");
      }).send(upload()),
    ).rejects.toThrow("NETWORK_RESULT_AMBIGUOUS");
    ledger.release();
    const resumed = new Ledger(dir, cipher);
    resumed.acquire();
    ledgers.push(resumed);
    resumed.load();
    expect(resumed.state.bytes).toBe(256);
    expect(resumed.state.allocations).toBe(1);
    expect(resumed.state.entries[0].state).toBe("ambiguous");
    const send = vi.fn(async () => ({ status: 200 }));
    await expect(
      runner(resumed, send).send({
        id: "download-A",
        actor: "A",
        purpose: "download",
        method: "GET",
        path: slot(0),
        expected: "allow",
      }),
    ).rejects.toThrow("INTERRUPTED_RUN_RECOVERY_REQUIRED");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("execution boundaries", () => {
  it("dry-run never invokes transport, credentials or ledger mutation", async () => {
    const { ledger } = state();
    const send = vi.fn(async () => ({ status: 200 }));
    const get = vi.fn();
    const generation = ledger.state.generation;
    const r = new Runner(ledger, { send });
    await r.send(upload());
    await r.authenticate("A", { get });
    expect(send).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(ledger.state.generation).toBe(generation);
    expect(dryRun().providerRequests).toBe(0);
  });
  it("execution without matching explicit approval is blocked before a request", async () => {
    const { ledger } = state();
    const send = vi.fn(async () => ({ status: 200 }));
    await expect(
      new Runner(ledger, { send }, undefined, undefined, false).send(upload()),
    ).rejects.toThrow("APPROVAL_REQUIRED");
    expect(send).not.toHaveBeenCalled();
    expect(() =>
      approve({ ...permission(), manifestHash: "wrong" }, permission().id),
    ).toThrow("APPROVAL_REQUIRED");
    expect(() =>
      approve({ ...permission(), expiresAt: "2000-01-01" }, permission().id),
    ).toThrow("APPROVAL_REQUIRED");
  });
  it("rejects unknown paths, actor/path mismatches and unrestricted denial probes", () => {
    expect(() =>
      validateIntent({ ...upload(), path: "unapproved-prefix/file.raw" }),
    ).toThrow("PATH_NOT_ALLOWLISTED");
    expect(() => validateIntent({ ...upload(), actor: "B" })).toThrow(
      "INTENT_NOT_APPROVED",
    );
    expect(() => validateIntent({ ...upload(), path: slot(6) })).toThrow(
      "INTENT_NOT_APPROVED",
    );
    expect(() => validateIntent({ ...upload(), expected: "deny" })).toThrow(
      "EXPECTATION_MISMATCH",
    );
    expect(PATHS).toHaveLength(12);
  });
  it("the runner namespace exactly matches the independently deployed policy artifact", () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        "experiments/storage/setup/storage-policies.deploy.sql",
      ),
      "utf8",
    );
    const approved = [
      ...new Set(
        [
          ...sql.matchAll(
            /'(p14b-20261011-c40e8e03\/[0-9a-f-]+\/\d{2}\.raw)'/g,
          ),
        ].map((m) => m[1]),
      ),
    ].sort();
    expect(PATHS.map((p) => p.path).sort()).toEqual(approved);
  });
  it("charges a denied wrong-owner upload as an allocation", async () => {
    const { ledger } = state();
    await runner(ledger, async () => ({ status: 403 })).send({
      id: "wrong-owner-B",
      actor: "B",
      purpose: "wrong-owner-upload",
      method: "POST",
      path: slot(1),
      body: fixture(32),
      expected: "deny",
    });
    expect(ledger.state.allocations).toBe(1);
    expect(ledger.state.bytes).toBe(32);
    expect(ledger.state.entries[0].state).toBe("completed");
  });
  it("stops immediately if a denial unexpectedly succeeds", async () => {
    const { ledger } = state();
    const r = runner(ledger, async () => ({ status: 200 }));
    await expect(
      r.send({
        id: "wrong-owner-B",
        actor: "B",
        purpose: "wrong-owner-upload",
        method: "POST",
        path: slot(1),
        body: fixture(32),
        expected: "deny",
      }),
    ).rejects.toThrow("UNEXPECTED_SUCCESS_FOR_DENIAL");
    expect(ledger.state.halted).toBe("UNEXPECTED_SUCCESS_FOR_DENIAL");
    expect(ledger.state.allocations).toBe(1);
    await expect(r.send(upload())).rejects.toThrow(
      "INTERRUPTED_RUN_RECOVERY_REQUIRED",
    );
  });
  it("rejects malformed denial without calling it an authorization pass", async () => {
    const { ledger } = state();
    await expect(
      runner(ledger, async () => ({ status: 400 })).send({
        id: "cross-read-B",
        actor: "B",
        purpose: "cross-read",
        method: "GET",
        path: slot(0),
        expected: "deny",
      }),
    ).rejects.toThrow("DENIAL_NOT_ESTABLISHED");
  });
  it("prohibits unbounded concurrency", async () => {
    const { ledger } = state();
    let finish!: (value: { status: number }) => void;
    const r = runner(
      ledger,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = r.send(upload());
    await expect(r.send(upload())).rejects.toThrow(
      "SEQUENTIAL_EXECUTION_REQUIRED",
    );
    finish({ status: 200 });
    await pending;
  });
  it("public reporting redacts stored tokens, resources and raw error detail", async () => {
    const { ledger } = state();
    const url = `https://${PROJECT}.storage.supabase.co/storage/v1/upload/resumable/${Buffer.from(`${BUCKET}/${slot(2)}/11111111-1111-4111-8111-111111111111`).toString("base64url")}`;
    await runner(ledger, async () => ({ status: 201, location: url })).send({
      id: "tus-create-A",
      actor: "A",
      purpose: "tus-create",
      method: "POST",
      path: slot(2),
      expected: "allow",
    });
    const report = JSON.stringify(summary(ledger));
    expect(report).not.toContain(url);
    expect(report).not.toContain("TEST_PRIVATE_TOKEN");
    expect(report).not.toContain(USERS.A.id);
    expect(safeError(new Error("Bearer secret password https://private"))).toBe(
      "FAIL_CLOSED",
    );
  });
  it("binds TUS resource origin and decoded bucket/path before continuation", () => {
    const path = slot(2);
    const url = `https://${PROJECT}.storage.supabase.co/storage/v1/upload/resumable/${Buffer.from(`${BUCKET}/${path}/11111111-1111-4111-8111-111111111111`).toString("base64url")}`;
    expect(boundResource(url, path)).toBe(url);
    expect(() => boundResource(url, slot(0))).toThrow("UNEXPECTED_RESOURCE");
    expect(() =>
      boundResource(url.replace(PROJECT, "otherproject"), path),
    ).toThrow("UNEXPECTED_RESOURCE");
  });
  it("marks unrecognized accepted TUS Location as halted while retaining private reference", async () => {
    const { ledger } = state();
    await expect(
      runner(ledger, async () => ({
        status: 201,
        location: "https://untrusted.example/resource",
      })).send({
        id: "tus-create-A",
        actor: "A",
        purpose: "tus-create",
        method: "POST",
        path: slot(2),
        expected: "allow",
      }),
    ).rejects.toThrow("UNEXPECTED_RESOURCE");
    expect(ledger.state.entries[0].resourceRef).toBeTruthy();
    expect(ledger.state.allocations).toBe(1);
  });
  it("requires an ordinary verified session and rejects privileged HTTP keys", async () => {
    const { ledger } = state();
    delete ledger.state.sessions.A;
    const send = vi.fn(async () => ({ status: 200 }));
    await expect(runner(ledger, send).send(upload())).rejects.toThrow(
      "VERIFIED_ORDINARY_SESSION_REQUIRED",
    );
    expect(send).not.toHaveBeenCalled();
    expect(() => new ProviderHttp("sb_secret_NOT_ALLOWED", ledger)).toThrow(
      "PUBLISHABLE_KEY_REQUIRED",
    );
  });
  it("records known HTTP status even when response parsing fails", async () => {
    const { ledger } = state();
    await expect(
      runner(ledger, async () => ({
        status: 200,
        errorCode: "RESPONSE_BODY_LIMIT",
      })).send(upload()),
    ).rejects.toThrow("RESPONSE_BODY_LIMIT");
    expect(ledger.state.entries[0].status).toBe(200);
  });
  it("the real HTTP adapter itself requires approval and a committed reservation", async () => {
    const { ledger } = state();
    const fetcher = vi.fn<typeof fetch>();
    const p = permission();
    expect(() => new ProviderHttp("sb_publishable_FIXTURE", ledger)).toThrow(
      "APPROVAL_REQUIRED",
    );
    const http = new ProviderHttp(
      "sb_publishable_FIXTURE",
      ledger,
      p,
      p.id,
      fetcher,
    );
    const token = `fixture.${Buffer.from(JSON.stringify({ role: "authenticated", sub: USERS.A.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
    await expect(http.send(upload(), token)).rejects.toThrow(
      "DURABLE_RESERVATION_REQUIRED",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses one mocked HTTP request with ordinary credentials, no redirects or upsert", async () => {
    const { ledger } = state();
    const p = permission();
    const token = `fixture.${Buffer.from(JSON.stringify({ role: "authenticated", sub: USERS.A.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
    ledger.update((s) => {
      s.sessions.A = { token, verified: true };
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new globalThis.Response("{}", { status: 200 }));
    const http = new ProviderHttp(
      "sb_publishable_FIXTURE",
      ledger,
      p,
      p.id,
      fetcher,
    );
    await new Runner(ledger, http, p, p.id, false).send(upload());
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toContain(`/storage/v1/object/${BUCKET}/`);
    expect(options?.redirect).toBe("error");
    expect(options?.headers).toMatchObject({
      Authorization: `Bearer ${token}`,
      "x-upsert": "false",
    });
  });
  it("Auth body bytes are counted and identity is checked without service credentials", async () => {
    const { ledger } = state();
    delete ledger.state.sessions.A;
    const token = `fixture.${Buffer.from(JSON.stringify({ role: "authenticated", sub: USERS.A.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
    const r = runner(ledger, async (intent) =>
      intent.purpose === "login"
        ? { status: 200, json: { access_token: token } }
        : {
            status: 200,
            json: {
              id: USERS.A.id,
              email: USERS.A.email,
              role: "authenticated",
              is_anonymous: false,
            },
          },
    );
    const password = "temporary-mock-password-not-a-real-secret";
    await r.authenticate("A", { get: () => ({ ...USERS.A, password }) });
    expect(ledger.state.bytes).toBe(
      Buffer.byteLength(JSON.stringify({ email: USERS.A.email, password })),
    );
    expect(ledger.state.allocations).toBe(0);
    expect(ledger.load().sessions.A?.verified).toBe(true);
    expect(JSON.stringify(summary(ledger))).not.toContain(password);
    expect(JSON.stringify(summary(ledger))).not.toContain(token);
  });
  it("mocked TUS HEAD and two parts update one resource without new allocations", async () => {
    const { ledger } = state();
    const path = slot(2);
    const location = `https://${PROJECT}.storage.supabase.co/storage/v1/upload/resumable/${Buffer.from(`${BUCKET}/${path}/11111111-1111-4111-8111-111111111111`).toString("base64url")}`;
    const r = runner(ledger, async (intent) =>
      intent.purpose === "tus-create"
        ? { status: 201, location }
        : intent.purpose === "tus-part"
          ? { status: 204, offset: intent.offset! + intent.body!.byteLength }
          : {
              status: 200,
              offset: ledger.state.resources[intent.resource!].offset,
              length: TUS_BYTES,
            },
    );
    await r.send({
      id: "tus-create-A",
      actor: "A",
      purpose: "tus-create",
      method: "POST",
      path,
      expected: "allow",
    });
    const resource = ledger.state.entries[0].resourceRef!;
    await r.send({
      id: "tus-head-zero",
      actor: "A",
      purpose: "tus-head",
      method: "HEAD",
      path,
      resource,
      expected: "allow",
    });
    await r.send({
      id: "tus-part-first",
      actor: "A",
      purpose: "tus-part",
      method: "PATCH",
      path,
      resource,
      offset: 0,
      body: fixture(TUS_BYTES).subarray(0, TUS_BYTES - 1_024),
      expected: "allow",
    });
    await r.send({
      id: "tus-head-recovery",
      actor: "A",
      purpose: "tus-head",
      method: "HEAD",
      path,
      resource,
      expected: "allow",
    });
    await r.send({
      id: "tus-part-tail",
      actor: "A",
      purpose: "tus-part",
      method: "PATCH",
      path,
      resource,
      offset: TUS_BYTES - 1_024,
      body: fixture(TUS_BYTES).subarray(TUS_BYTES - 1_024),
      expected: "allow",
    });
    expect(ledger.state.resources[resource].complete).toBe(true);
    expect(ledger.state.bytes).toBe(TUS_BYTES);
    expect(ledger.state.allocations).toBe(1);
    expect(ledger.state.entries[3].resourceRef).toBe(resource);
  });
  it("verifies exact downloaded bytes", async () => {
    const { ledger } = state();
    await runner(ledger, async () => ({
      status: 200,
      responseBytes: 256,
      digest: hash(fixture(256)),
    })).send({
      id: "download-A",
      actor: "A",
      purpose: "download",
      method: "GET",
      path: slot(0),
      expected: "allow",
    });
    expect(ledger.state.entries[0].state).toBe("completed");
  });
});

describe("cleanup and private store boundaries", () => {
  it("previews only recorded completed owned objects with verified owner evidence", async () => {
    const { ledger } = state();
    await runner(ledger, async () => ({ status: 200 })).send(upload());
    expect(ledger.cleanupPreview()).toEqual([]);
    ledger.observeOwner(slot(0), USERS.A.id);
    expect(ledger.cleanupPreview()).toEqual([
      { actor: "A", path: slot(0), slot: 0 },
    ]);
    ledger.observeOwner(slot(6), USERS.B.id);
    expect(ledger.cleanupPreview()).toHaveLength(1);
    expect(() =>
      ledger.observeOwner("unrecorded/unapproved", USERS.A.id),
    ).toThrow("PATH_NOT_ALLOWLISTED");
    expect(() =>
      validateIntent(
        {
          id: "cleanup",
          actor: "A",
          purpose: "cleanup",
          method: "DELETE",
          path: slot(2),
          expected: "allow",
        },
        [slot(0)],
      ),
    ).toThrow("CLEANUP_NOT_ELIGIBLE");
  });
  it("execution approval never authorizes deletion and the dry cleanup preview sends nothing", async () => {
    const { ledger } = state();
    const send = vi.fn(async () => ({ status: 200 }));
    await expect(
      runner(ledger, send).send({
        id: "cleanup",
        actor: "A",
        purpose: "cleanup",
        method: "DELETE",
        path: slot(0),
        expected: "allow",
      }),
    ).rejects.toThrow("APPROVAL_REQUIRED");
    ledger.cleanupPreview();
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects repository-based private storage", () => {
    expect(() =>
      outsideRepository(join(process.cwd(), ".cache", "ledger"), process.cwd()),
    ).toThrow("PRIVATE_STORE_MUST_BE_OUTSIDE_REPOSITORY");
  });
  it("rejects a short non-final TUS PATCH before spending or transport", async () => {
    const { ledger } = state();
    const send = vi.fn(async () => ({ status: 204 }));
    await expect(
      runner(ledger, send).send({
        id: "tus-part-first",
        actor: "A",
        purpose: "tus-part",
        method: "PATCH",
        path: slot(2),
        offset: 0,
        body: fixture(1024),
        expected: "allow",
      }),
    ).rejects.toThrow("TUS_CHUNK_SEQUENCE_REQUIRED");
    expect(send).not.toHaveBeenCalled();
    expect(ledger.state.bytes).toBe(0);
  });
  it("HTTP rejects an allocation incorrectly reserved as a read", async () => {
    const { ledger } = state();
    const p = permission();
    const fetcher = vi.fn<typeof fetch>();
    ledger.reserve(upload(), false);
    const http = new ProviderHttp(
      "sb_publishable_FIXTURE",
      ledger,
      p,
      p.id,
      fetcher,
    );
    await expect(http.send(upload())).rejects.toThrow(
      "DURABLE_RESERVATION_REQUIRED",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("fixed unique stages imply the exact first-wave ceilings", () => {
    const plan = dryRun();
    expect(plan.firstWaveAllocationAttempts).toBe(3);
    expect(plan.firstWaveMaximumBodyBytes).toBe(6_325_536);
    expect(new Set(plan.stages.map((s) => s.id)).size).toBe(17);
  });
  it("HTTP sends the exact non-final 6 MiB TUS body with required headers", async () => {
    const { ledger } = state();
    const p = permission();
    const token = `fixture.${Buffer.from(JSON.stringify({ role: "authenticated", sub: USERS.A.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
    const url = `https://${PROJECT}.storage.supabase.co/storage/v1/upload/resumable/${Buffer.from(`${BUCKET}/${slot(2)}/11111111-1111-4111-8111-111111111111`).toString("base64url")}`;
    ledger.update((s) => {
      s.sessions.A = { token, verified: true };
      s.resources.disposable = {
        url,
        actor: "A",
        path: slot(2),
        offset: 0,
        complete: false,
      };
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new globalThis.Response(null, {
        status: 204,
        headers: { "Upload-Offset": "6291456" },
      }),
    );
    const http = new ProviderHttp(
      "sb_publishable_FIXTURE",
      ledger,
      p,
      p.id,
      fetcher,
    );
    await new Runner(ledger, http, p, p.id, false).send({
      id: "tus-part-first",
      actor: "A",
      method: "PATCH",
      purpose: "tus-part",
      path: slot(2),
      resource: "disposable",
      offset: 0,
      body: fixture(6_291_456),
      expected: "allow",
    });
    const [, options] = fetcher.mock.calls[0];
    expect(options?.headers).toMatchObject({
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": "0",
      "Content-Type": "application/offset+octet-stream",
    });
    expect((options?.body as Buffer).byteLength).toBe(6_291_456);
    expect(ledger.state.bytes).toBe(6_291_456);
    expect(options?.redirect).toBe("error");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("incomplete TUS entries are not cleanup-eligible", async () => {
    const { ledger } = state();
    const url = `https://${PROJECT}.storage.supabase.co/storage/v1/upload/resumable/${Buffer.from(`${BUCKET}/${slot(2)}/11111111-1111-4111-8111-111111111111`).toString("base64url")}`;
    await runner(ledger, async () => ({ status: 201, location: url })).send({
      id: "tus-create-A",
      actor: "A",
      purpose: "tus-create",
      method: "POST",
      path: slot(2),
      expected: "allow",
    });
    ledger.observeOwner(slot(2), USERS.A.id);
    expect(ledger.cleanupPreview()).toEqual([]);
    expect(Object.values(ledger.state.resources)[0].complete).toBe(false);
    expect(TUS_BYTES).toBe(6_292_480);
  });
});
function haltedCrossRead(fault?: (point: string) => void) {
  const context = state(fault);
  for (const [i, stage] of STAGES.slice(0, 7).entries()) {
    const intent: Intent = {
      id: stage.id,
      actor: stage.actor,
      purpose: stage.purpose,
      method: stage.method,
      path: "path" in stage ? stage.path : undefined,
      expected: i === 6 ? "deny" : "allow",
      body:
        i === 0 || i === 2
          ? new Uint8Array(109)
          : i === 4
            ? fixture(256)
            : undefined,
    };
    const entry = context.ledger.reserve(intent, i === 4);
    context.ledger.update((s) => {
      const e = s.entries[entry.sequence - 1];
      e.status = i === 6 ? 400 : 200;
      e.state = i === 6 ? "failed" : "completed";
    });
  }
  context.ledger.halt("DENIAL_NOT_ESTABLISHED");
  return context;
}
function reconciliation(): DenialReconciliation {
  return {
    classification: "EXPECTED_PROVIDER_DENIAL",
    ordinaryRole: true,
    appVersion: "1.80.2",
    providerEventAt: "2026-10-12T15:49:58.826Z",
    stage: "cross-read-B",
    source: "VALIDATED_EXISTING_PROVIDER_LOG",
    evidenceDigest: hash("TEST_ONLY_PROVIDER_EVIDENCE"),
    recordedAt: new Date().toISOString(),
    originalState: "failed",
    originalHalt: "DENIAL_NOT_ESTABLISHED",
    originalStatus: 400,
    allocations: 1,
    bytes: 474,
    actor: "B",
    method: "GET",
    object: {
      bucket: BUCKET,
      path: slot(0),
      ownerId: USERS.A.id,
      exists: true,
    },
    error: {
      code: "NoSuchKey",
      logicalStatus: 404,
      message: "Object not found",
    },
  };
}
const crossIntent = (): Intent => ({
  id: "cross-read-B",
  actor: "B",
  purpose: "cross-read",
  method: "GET",
  path: slot(0),
  expected: "deny",
});

describe("focused local denial recovery", () => {
  it("accepts only the exact validated cross-read denial", () => {
    const r = reconciliation();
    expect(isCrossReadDenial(crossIntent(), 400, r.error, r.object)).toBe(true);
  });
  it.each([
    "stage",
    "actor",
    "path",
    "method",
    "http",
    "code",
    "logical",
    "message",
    "owner",
    "exists",
    "bucket",
    "expectation",
  ])("rejects mismatched %s", (field) => {
    const r = reconciliation();
    const intent = crossIntent();
    let status = 400;
    if (field === "stage") intent.id = "anonymous-read";
    if (field === "actor") intent.actor = "A";
    if (field === "path") intent.path = slot(1);
    if (field === "method") intent.method = "POST";
    if (field === "http") status = 200;
    if (field === "code") r.error.code = "InvalidRequest";
    if (field === "logical") r.error.logicalStatus = 400;
    if (field === "message") r.error.message = "REDACTED";
    if (field === "owner") r.object.ownerId = USERS.B.id;
    if (field === "exists") r.object.exists = false;
    if (field === "bucket") r.object.bucket = "other-bucket";
    if (field === "expectation") intent.expected = "allow";
    expect(isCrossReadDenial(intent, status, r.error, r.object)).toBe(false);
  });
  it("sanitizes error JSON and rejects missing or malformed logical status", () => {
    expect(
      parseProviderError({
        code: "NoSuchKey",
        statusCode: "404",
        message: "Object not found",
      }),
    ).toEqual(reconciliation().error);
    const sanitized = parseProviderError({
      code: "SECRET_TOKEN",
      statusCode: "404junk",
      message: "https://private/SECRET_TOKEN",
    });
    expect(sanitized?.code).toBe("UNRECOGNIZED_PROVIDER_ERROR");
    expect(sanitized?.logicalStatus).toBeUndefined();
    expect(JSON.stringify(sanitized)).not.toContain("SECRET_TOKEN");
    expect(parseProviderError([])).toBeUndefined();
  });
  it("appends reconciliation while preserving failed entry, original journal and counters", () => {
    const { ledger, dir } = haltedCrossRead();
    const original = JSON.stringify(ledger.state.entries);
    const journal = readFileSync(join(dir, "journal"), "utf8");
    ledger.reconcileCrossRead(reconciliation());
    expect(readFileSync(join(dir, "journal"), "utf8").startsWith(journal)).toBe(
      true,
    );
    expect(JSON.stringify(ledger.load().entries)).toBe(original);
    expect(ledger.state.halted).toBe("DENIAL_NOT_ESTABLISHED");
    expect(ledger.state.allocations).toBe(1);
    expect(ledger.state.bytes).toBe(474);
    expect(ledger.isCompleted("cross-read-B")).toBe(true);
    expect(ledger.isHalted()).toBe(false);
    expect(ledger.state.reconciliations).toHaveLength(1);
    expect(() => ledger.reconcileCrossRead(reconciliation())).toThrow(
      "RECONCILIATION_PRECONDITION_FAILED",
    );
  });
  it("rejects unvalidated reconciliation evidence without changing state", () => {
    const { ledger } = haltedCrossRead();
    const before = JSON.stringify(ledger.state);
    const r = reconciliation();
    r.error.logicalStatus = 400;
    expect(() => ledger.reconcileCrossRead(r)).toThrow(
      "RECONCILIATION_PRECONDITION_FAILED",
    );
    expect(JSON.stringify(ledger.state)).toBe(before);
    expect(ledger.isHalted()).toBe(true);
  });
  it("plans only ten remaining stages and never authenticates or replays completed requests", async () => {
    const { ledger } = haltedCrossRead();
    ledger.reconcileCrossRead(reconciliation());
    expect(ledger.continuationPlan()).toEqual({
      stages: STAGES.slice(7).map((s) => s.id),
      allocationAttempts: 2,
      maximumBodyBytes: 6_292_512,
    });
    const send = vi.fn(async () => ({ status: 200 }));
    const credentials = { get: vi.fn() };
    const r = runner(ledger, send);
    await r.authenticate("A", credentials);
    await r.authenticate("B", credentials);
    for (const s of STAGES.slice(0, 7))
      expect(ledger.isCompleted(s.id)).toBe(true);
    await expect(r.send(crossIntent())).rejects.toThrow("PURPOSE_NOT_APPROVED");
    expect(send).not.toHaveBeenCalled();
    expect(credentials.get).not.toHaveBeenCalled();
  });
  it("future unrelated HTTP 400 still halts a reconciled run", async () => {
    const { ledger } = haltedCrossRead();
    ledger.reconcileCrossRead(reconciliation());
    const send = vi.fn(async () => ({
      status: 400,
      providerError: reconciliation().error,
    }));
    await expect(
      runner(ledger, send).send({
        id: "wrong-owner-B",
        actor: "B",
        purpose: "wrong-owner-upload",
        method: "POST",
        path: slot(1),
        body: fixture(32),
        expected: "deny",
      }),
    ).rejects.toThrow("DENIAL_NOT_ESTABLISHED");
    expect(ledger.isHalted()).toBe(true);
    expect(ledger.state.allocations).toBe(2);
    expect(ledger.state.bytes).toBe(506);
  });
  it("HTTP adapter retains only sanitized provider error fields", async () => {
    const { ledger } = state();
    const p = permission();
    const token = `fixture.${Buffer.from(JSON.stringify({ role: "authenticated", sub: USERS.B.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
    ledger.update((s) => {
      s.sessions.B = { token, verified: true };
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new globalThis.Response(
        JSON.stringify({
          code: "NoSuchKey",
          statusCode: "404",
          message: "Object not found",
          private: "SECRET_RESPONSE_VALUE",
        }),
        { status: 400 },
      ),
    );
    const http = new ProviderHttp(
      "sb_publishable_FIXTURE",
      ledger,
      p,
      p.id,
      fetcher,
    );
    await expect(
      new Runner(ledger, http, p, p.id, false).send(crossIntent()),
    ).rejects.toThrow("DENIAL_NOT_ESTABLISHED"); // no independent ownership evidence
    expect(ledger.state.entries[0].providerError).toEqual(
      reconciliation().error,
    );
    expect(JSON.stringify(ledger.state)).not.toContain("SECRET_RESPONSE_VALUE");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("interrupted reconciliation commit fails closed on restart", () => {
    let interrupted = false;
    const { ledger } = haltedCrossRead((point) => {
      if (interrupted && point === "before-snapshot-rename")
        throw new Error("TEST_INTERRUPT");
    });
    interrupted = true;
    expect(() => ledger.reconcileCrossRead(reconciliation())).toThrow(
      "TEST_INTERRUPT",
    );
    expect(() => ledger.load()).toThrow("LEDGER_INTEGRITY_RECOVERY_REQUIRED");
  });
});
function continuationPermission(ledger: Ledger): Approval {
  return {
    ...permission(),
    schemaVersion: 2,
    issuedAt: new Date().toISOString(),
    purposes: [...new Set(STAGES.slice(7).map((s) => s.purpose))],
    continuation: continuationCheckpoint(ledger),
  };
}
const wrongOwnerIntent = (): Intent => ({
  id: "wrong-owner-B",
  actor: "B",
  purpose: "wrong-owner-upload",
  method: "POST",
  path: slot(1),
  body: fixture(32),
  expected: "deny",
});
describe("checkpoint-bound continuation approval", () => {
  function prepared() {
    const x = haltedCrossRead();
    x.ledger.reconcileCrossRead(reconciliation());
    return { ...x, p: continuationPermission(x.ledger) };
  }
  it("accepts exact checkpoint without altering ledger", () => {
    const { ledger, p } = prepared();
    const before = JSON.stringify(ledger.state);
    assertContinuation(ledger, p, wrongOwnerIntent());
    expect(JSON.stringify(ledger.state)).toBe(before);
  });
  it.each(["ledgerIdentity", "digest"] as const)(
    "rejects modified %s",
    (field) => {
      const { ledger, p } = prepared();
      p.continuation![field] = "a".repeat(64);
      expect(() => assertContinuation(ledger, p)).toThrow(
        "CONTINUATION_CHECKPOINT_INVALID",
      );
    },
  );
  it("rejects wrong generation", () => {
    const { ledger, p } = prepared();
    p.continuation!.generation += 1;
    expect(() => assertContinuation(ledger, p)).toThrow(
      "CONTINUATION_CHECKPOINT_INVALID",
    );
  });
  it("rejects old approval", () => {
    const { ledger } = prepared();
    expect(() => assertContinuation(ledger, permission())).toThrow(
      "CONTINUATION_APPROVAL_REQUIRED",
    );
  });
  it.each(["expiry", "lifetime", "future", "stages", "budget"])(
    "rejects invalid approval %s",
    (field) => {
      const { p } = prepared();
      if (field === "expiry") p.expiresAt = "2000-01-01";
      if (field === "lifetime")
        p.expiresAt = new Date(Date.now() + 1800001).toISOString();
      if (field === "future")
        p.issuedAt = new Date(Date.now() + 60000).toISOString();
      if (field === "stages") p.continuation!.stages.push("rest-A");
      if (field === "budget")
        p.continuation!.maxAdditionalBytes = 6325062 as 6292512;
      expect(() => approve(p, p.id)).toThrow();
    },
  );
  it.each(["rest-A", "anonymous-read", "extra"])(
    "rejects replay or out-of-order stage %s",
    (id) => {
      const { ledger, p } = prepared();
      expect(() =>
        assertContinuation(ledger, p, { ...wrongOwnerIntent(), id }),
      ).toThrow("CONTINUATION_STAGE_NOT_APPROVED");
    },
  );
  it("enforces progression across restart", async () => {
    const { ledger, p, dir, cipher } = prepared();
    const r = new Runner(
      ledger,
      { send: async () => ({ status: 403 }) },
      p,
      p.id,
      false,
    );
    await r.send(wrongOwnerIntent());
    ledger.release();
    const restarted = new Ledger(dir, cipher);
    restarted.acquire();
    ledgers.push(restarted);
    restarted.load();
    assertContinuation(restarted, p, {
      id: "anonymous-read",
      actor: "anonymous",
      purpose: "anonymous-read",
      method: "GET",
      path: slot(0),
      expected: "deny",
    });
    expect(restarted.state.allocations).toBe(2);
    expect(restarted.state.bytes).toBe(506);
    expect(() =>
      assertContinuation(restarted, p, wrongOwnerIntent()),
    ).toThrow();
  });
  it("rejects tampered prefix", () => {
    const { ledger, p } = prepared();
    ledger.update((s) => {
      s.entries[4].cleanup = "uncertain";
    });
    expect(() => assertContinuation(ledger, p)).toThrow();
  });
  it("rejects modified session history", () => {
    const { ledger, p } = prepared();
    ledger.update((s) => {
      s.sessions.A!.token = "CHANGED";
    });
    expect(() => assertContinuation(ledger, p)).toThrow(
      "SESSION_RENEWAL_HISTORY_INVALID",
    );
  });
  it("rejects exhausted budget", () => {
    const { ledger, p } = prepared();
    ledger.update((s) => {
      s.entries.push({
        sequence: 8,
        id: "wrong-owner-B",
        actor: "B",
        bucket: BUCKET,
        path: slot(1),
        allocation: true,
        allocationAttempt: 2,
        method: "POST",
        purpose: "wrong-owner-upload",
        bodyBytes: 6292513,
        cumulativeBytes: 6292987,
        state: "reserved",
        cleanup: "not-eligible",
      });
      s.allocations = 2;
      s.bytes = 6292987;
    });
    expect(() => assertContinuation(ledger, p)).toThrow(
      "CONTINUATION_HISTORY_INVALID",
    );
  });
  it("rejects expiry at adapter boundary", () => {
    const { ledger, p } = prepared();
    ledger.reserve(wrongOwnerIntent(), true);
    p.expiresAt = new Date(Date.now() - 1).toISOString();
    const fetcher = vi.fn<typeof fetch>();
    expect(
      () => new ProviderHttp("sb_publishable_TEST", ledger, p, p.id, fetcher),
    ).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
describe("complete mocked continuation with fixed checkpoint", () => {
  it("allows all ten stages and owner enrichment without replay", async () => {
    const { ledger } = haltedCrossRead();
    ledger.reconcileCrossRead(reconciliation());
    const p = continuationPermission(ledger);
    const location = `https://${PROJECT}.storage.supabase.co/storage/v1/upload/resumable/${Buffer.from(`${BUCKET}/${slot(2)}/11111111-1111-4111-8111-111111111111`).toString("base64url")}`;
    const send = vi.fn<Transport["send"]>(async (intent) =>
      intent.expected === "deny"
        ? { status: 403 }
        : intent.purpose === "tus-create"
          ? { status: 201, location }
          : intent.purpose === "tus-part"
            ? { status: 204, offset: intent.offset! + intent.body!.byteLength }
            : intent.purpose === "tus-head"
              ? {
                  status: 200,
                  offset: ledger.state.resources[intent.resource!].offset,
                  length: TUS_BYTES,
                }
              : { status: 200, json: { owner_id: USERS.A.id } },
    );
    const r = new Runner(ledger, { send }, p, p.id, false);
    for (const stage of STAGES.slice(7)) {
      const resource = Object.keys(ledger.state.resources)[0];
      const intent: Intent = {
        id: stage.id,
        actor: stage.actor,
        purpose: stage.purpose,
        method: stage.method,
        path: "path" in stage ? stage.path : undefined,
        expected: ["wrong-owner-upload", "anonymous-read"].includes(
          stage.purpose,
        )
          ? "deny"
          : "allow",
      };
      if (stage.maxBytes) intent.body = fixture(stage.maxBytes);
      if (stage.purpose === "tus-part" || stage.purpose === "tus-head")
        intent.resource = resource;
      if (stage.purpose === "tus-part")
        intent.offset = stage.id === "tus-part-first" ? 0 : TUS_BYTES - 1024;
      await r.send(intent);
    }
    assertContinuation(ledger, p);
    expect(send).toHaveBeenCalledTimes(10);
    expect(ledger.state.allocations).toBe(3);
    expect(ledger.state.bytes).toBe(6292986);
    expect(ledger.state.entries[6].state).toBe("failed");
    expect(ledger.isReconciled("cross-read-B")).toBe(true);
  });
  it("validates continuation at native adapter boundary without real HTTP", async () => {
    const { ledger } = haltedCrossRead();
    ledger.reconcileCrossRead(reconciliation());
    const p = continuationPermission(ledger);
    const intent = wrongOwnerIntent();
    ledger.reserve(intent, true);
    const claims = {
      role: "authenticated",
      sub: USERS.B.id,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const token = `a.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 403 }));
    const http = new ProviderHttp(
      "sb_publishable_TEST",
      ledger,
      p,
      p.id,
      fetcher,
    );
    await http.send(intent, token);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
describe("controlled expired session renewal", () => {
  function prepared() {
    const x = haltedCrossRead();
    x.ledger.update((s) => {
      for (const actor of ["A", "B"] as const)
        s.sessions[actor] = { token: testToken(actor, true), verified: true };
    });
    x.ledger.reconcileCrossRead(reconciliation());
    return {
      ...x,
      p: renewalCandidate(x.ledger),
      continuation: continuationPermission(x.ledger),
    };
  }
  const credentials = {
    get: (actor: "A" | "B") => ({
      ...USERS[actor],
      password: "disposable-fixture-password-32-characters",
    }),
  };
  const send = async (r: Parameters<RenewalTransport["send"]>[0]) => ({
    status: 200,
    json:
      r.operation === "login"
        ? { access_token: testToken(r.actor) }
        : { ...USERS[r.actor], role: "authenticated", is_anonymous: false },
  });
  it("rejects expired verified session without Auth or storage requests", async () => {
    const { ledger, continuation } = prepared();
    const transport = vi.fn(async () => ({ status: 200 }));
    const r = new Runner(
      ledger,
      { send: transport },
      continuation,
      continuation.id,
      false,
    );
    await expect(r.authenticate("A", credentials)).rejects.toThrow(
      "SESSION_EXPIRED_RENEWAL_REQUIRED",
    );
    await expect(r.send(wrongOwnerIntent())).rejects.toThrow(
      "SESSION_EXPIRED_RENEWAL_REQUIRED",
    );
    expect(transport).not.toHaveBeenCalled();
    expect(ledger.state.allocations).toBe(1);
    expect(ledger.state.bytes).toBe(474);
  });
  it("renews two identities append-only, preserves prefix, counts auth separately", async () => {
    const { ledger, p, continuation, dir } = prepared();
    const original = readFileSync(join(dir, "journal"));
    const entries = JSON.stringify(ledger.state.entries);
    const before = structuredClone(ledger.state.sessions);
    const transport = vi.fn(send);
    await renewSessions(
      ledger,
      p,
      p.id,
      credentials,
      { send: transport },
      () => {},
    );
    expect(transport).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(ledger.state.entries)).toBe(entries);
    expect(
      readFileSync(join(dir, "journal"))
        .subarray(0, original.length)
        .equals(original),
    ).toBe(true);
    expect(ledger.state.renewalEvents![0].previousSession).toEqual(before.A);
    expect(ledger.state.renewalEvents![2].previousSession).toEqual(before.B);
    expect(usableSession(ledger.state.sessions.A!.token, "A")).toBe(true);
    expect(ledger.state.allocations).toBe(1);
    expect(ledger.state.bytes).toBe(474);
    expect(renewalBytes(ledger.state)).toBeGreaterThan(0);
    assertContinuation(ledger, continuation, wrongOwnerIntent());
    assertContinuation(
      ledger,
      continuationPermission(ledger),
      wrongOwnerIntent(),
    );
  });
  it("identity mismatch never verifies new token", async () => {
    const { ledger, p } = prepared();
    const before = ledger.state.sessions.A!.token;
    await expect(
      renewSessions(
        ledger,
        p,
        p.id,
        credentials,
        {
          send: async (r) =>
            r.operation === "identity"
              ? {
                  status: 200,
                  json: {
                    ...USERS.B,
                    role: "authenticated",
                    is_anonymous: false,
                  },
                }
              : send(r),
        },
        () => {},
      ),
    ).rejects.toThrow("SESSION_RENEWAL_VERIFICATION_FAILED");
    expect(ledger.state.sessions.A!.token).toBe(before);
    expect(ledger.state.renewalEvents!.at(-1)!.state).toBe("failed");
    expect(() => ledger.reserve(wrongOwnerIntent(), true)).toThrow(
      "SESSION_RENEWAL_INTERRUPTED",
    );
  });
  it.each(["login", "identity"])(
    "ambiguous %s is durable and cannot retry",
    async (operation) => {
      const { ledger, p } = prepared();
      await expect(
        renewSessions(
          ledger,
          p,
          p.id,
          credentials,
          {
            send: async (r) => {
              if (r.operation === operation) throw Error("fixture-network");
              return send(r);
            },
          },
          () => {},
        ),
      ).rejects.toThrow("SESSION_RENEWAL_INTERRUPTED");
      expect(ledger.load().renewalEvents!.at(-1)!.state).toBe("ambiguous");
      expect(() => renewalCandidate(ledger)).toThrow(
        "SESSION_RENEWAL_ALREADY_ATTEMPTED",
      );
      expect(ledger.state.allocations).toBe(1);
      expect(ledger.state.bytes).toBe(474);
    },
  );
  it("expired approval stops before any credential read or request", async () => {
    const { ledger, p } = prepared();
    p.expiresAt = new Date(Date.now() - 1).toISOString();
    const get = vi.fn(credentials.get),
      transport = vi.fn(send);
    await expect(
      renewSessions(ledger, p, p.id, { get }, { send: transport }, () => {}),
    ).rejects.toThrow("SESSION_RENEWAL_APPROVAL_REQUIRED");
    expect(get).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it("requires matching checkpoint and distinct approval purpose", async () => {
    const { ledger, p } = prepared();
    p.digest = "a".repeat(64);
    await expect(
      renewSessions(ledger, p, p.id, credentials, { send }, () => {}),
    ).rejects.toThrow("CONTINUATION_CHECKPOINT_INVALID");
  });
  it("rejects wrong token subject and leaves ordinary session unchanged", async () => {
    const { ledger, p } = prepared();
    await expect(
      renewSessions(
        ledger,
        p,
        p.id,
        credentials,
        {
          send: async () => ({
            status: 200,
            json: { access_token: testToken("B") },
          }),
        },
        () => {},
      ),
    ).rejects.toThrow("SESSION_RENEWAL_VERIFICATION_FAILED");
    expect(usableSession(ledger.state.sessions.A!.token, "A")).toBe(false);
  });
  it("prevents completed-stage replay after renewal", async () => {
    const { ledger, p, continuation } = prepared();
    await renewSessions(ledger, p, p.id, credentials, { send }, () => {});
    expect(() =>
      assertContinuation(ledger, continuation, {
        ...wrongOwnerIntent(),
        id: "rest-A",
      }),
    ).toThrow("CONTINUATION_STAGE_NOT_APPROVED");
    await expect(
      renewSessions(ledger, p, p.id, credentials, { send }, () => {}),
    ).rejects.toThrow("SESSION_RENEWAL_ALREADY_ATTEMPTED");
  });
  it("rejects edited renewal evidence across journal history", async () => {
    const { ledger, p, continuation } = prepared();
    await renewSessions(ledger, p, p.id, credentials, { send }, () => {});
    ledger.update((s) => {
      s.renewalEvents![0].at = new Date(
        Date.parse(s.renewalEvents![0].at) + 1,
      ).toISOString();
    });
    expect(() => assertContinuation(ledger, continuation)).toThrow();
  });
  it("native renewal transport uses four bounded no-redirect Auth requests only", async () => {
    const { ledger, p } = prepared();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, options) => {
        expect(String(url)).toMatch(
          /\/auth\/v1\/(token\?grant_type=password|user)$/,
        );
        expect(options?.redirect).toBe("error");
        const actor = String(url).includes("token?")
          ? JSON.parse(String(options!.body)).email === USERS.A.email
            ? "A"
            : "B"
          : JSON.parse(
                Buffer.from(
                  (
                    options!.headers as Record<string, string>
                  ).Authorization.split(".")[1],
                  "base64url",
                ).toString("utf8"),
              ).sub === USERS.A.id
            ? "A"
            : "B";
        return new Response(
          JSON.stringify(
            String(url).includes("token?")
              ? { access_token: testToken(actor) }
              : { ...USERS[actor], role: "authenticated", is_anonymous: false },
          ),
          { status: 200 },
        );
      });
    await renewSessions(
      ledger,
      p,
      p.id,
      credentials,
      new NativeRenewalHttp(
        "sb_publishable_TEST",
        p,
        p.id,
        () => {},
        ledger,
        fetcher,
      ),
      () => {},
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(ledger.state.renewalEvents).toHaveLength(4);
    expect(
      () =>
        new NativeRenewalHttp(
          "service_role",
          p,
          p.id,
          () => {},
          ledger,
          fetcher,
        ),
    ).toThrow("PUBLISHABLE_KEY_REQUIRED");
  });
  it("rejects direct native transport without durable renewal reservation", async () => {
    const { ledger, p } = prepared();
    const fetcher = vi.fn<typeof fetch>();
    const http = new NativeRenewalHttp(
      "sb_publishable_TEST",
      p,
      p.id,
      () => {},
      ledger,
      fetcher,
    );
    await expect(
      http.send({
        actor: "A",
        operation: "login",
        body: Buffer.from(
          JSON.stringify({
            email: USERS.A.email,
            password: "disposable-fixture-password-32-characters",
          }),
        ),
      }),
    ).rejects.toThrow("SESSION_RENEWAL_RESERVATION_REQUIRED");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
it("expired or missing JWT expiration never becomes usable", () => {
  const token = `fixture.${Buffer.from(JSON.stringify({ iat: 100, exp: 3700 })).toString("base64url")}.signature`;
  expect(sessionLifetime(token, 1900000)).toEqual({
    remainingSeconds: 1800,
    issuedLifetimeSeconds: 3600,
  });
  expect(JSON.stringify(sessionLifetime(token))).not.toContain(token);
  expect(usableSession(testToken("A", true), "A")).toBe(false);
  expect(
    usableSession(
      `fixture.${Buffer.from(JSON.stringify({ role: "authenticated", sub: USERS.A.id })).toString("base64url")}.signature`,
      "A",
    ),
  ).toBe(false);
  expect(usableSession(testToken("B"), "A")).toBe(false);
});
it("interrupted renewal commit fails closed before Auth dispatch", async () => {
  let armed = false;
  const { ledger } = haltedCrossRead((point) => {
    if (armed && point === "before-snapshot-rename") throw Error("FAULT");
  });
  ledger.update((s) => {
    for (const actor of ["A", "B"] as const)
      s.sessions[actor] = { token: testToken(actor, true), verified: true };
  });
  ledger.reconcileCrossRead(reconciliation());
  const p = renewalCandidate(ledger);
  const transport = vi.fn(async () => ({ status: 200, json: {} }));
  armed = true;
  await expect(
    renewSessions(
      ledger,
      p,
      p.id,
      {
        get: (actor) => ({
          ...USERS[actor],
          password: "disposable-fixture-password-32-characters",
        }),
      },
      { send: transport },
      () => {},
    ),
  ).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  expect(() => ledger.load()).toThrow("LEDGER_INTEGRITY_RECOVERY_REQUIRED");
});
describe("private continuation helper", () => {
  afterEach(() => vi.useRealTimers());
  async function ready() {
    const x = haltedCrossRead();
    x.ledger.update((s) => {
      for (const actor of ["A", "B"] as const)
        s.sessions[actor] = { token: testToken(actor, true), verified: true };
    });
    x.ledger.reconcileCrossRead(reconciliation());
    const p = renewalCandidate(x.ledger);
    await renewSessions(
      x.ledger,
      p,
      p.id,
      {
        get: (actor) => ({
          ...USERS[actor],
          password: "disposable-fixture-password-32-characters",
        }),
      },
      {
        send: async (r) => ({
          status: 200,
          json:
            r.operation === "login"
              ? { access_token: testToken(r.actor) }
              : {
                  ...USERS[r.actor],
                  role: "authenticated",
                  is_anonymous: false,
                },
        }),
      },
      () => {},
    );
    return x;
  }
  it("second renewal preserves first history, counters and supports fresh continuation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { ledger } = await ready();
    expect(() => renewalCandidate(ledger, true)).toThrow(
      "SECOND_RENEWAL_NOT_NEEDED",
    );
    const original = structuredClone(ledger.state.renewalEvents);
    const entries = structuredClone(ledger.state.entries);
    vi.setSystemTime(Date.now() + 31 * 60000);
    const p = renewalCandidate(ledger, true);
    const send = vi.fn(async (r: { actor: "A" | "B"; operation: string }) => ({
      status: 200,
      json:
        r.operation === "login"
          ? { access_token: testToken(r.actor) }
          : { ...USERS[r.actor], role: "authenticated", is_anonymous: false },
    }));
    await renewSessions(
      ledger,
      p,
      p.id,
      {
        get: (actor) => ({
          ...USERS[actor],
          password: "disposable-fixture-password-32-characters",
        }),
      },
      { send },
      () => {},
    );
    expect(send).toHaveBeenCalledTimes(4);
    expect(ledger.state.renewalEvents!.slice(0, 4)).toEqual(original);
    expect(ledger.state.entries).toEqual(entries);
    expect(ledger.state.allocations).toBe(1);
    expect(ledger.state.bytes).toBe(474);
    expect(ledger.state.renewalEvents).toHaveLength(8);
    ledger.load();
    expect(continuationCandidate(ledger).continuation!.stages).toHaveLength(10);
    expect(() => renewalCandidate(ledger, true)).toThrow(
      "SECOND_RENEWAL_REQUIRES_COMPLETED_FIRST",
    );
    await expect(
      renewSessions(
        ledger,
        p,
        p.id,
        {
          get: () => {
            throw Error("MUST_NOT_READ");
          },
        },
        { send },
        () => {},
      ),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(4);
  });
  it("requires separate exact Auth confirmation before creating second approval", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { ledger } = await ready();
    vi.setSystemTime(Date.now() + 31 * 60000);
    const create = vi.fn(() => "DISPOSABLE_ONLY");
    await expect(
      confirmSecondRenewal(
        ledger,
        async () => "EXECUTE TEN STORAGE STAGES",
        create,
        () => {},
      ),
    ).rejects.toThrow("SESSION_RENEWAL_NOT_CONFIRMED");
    expect(create).not.toHaveBeenCalled();
    const result = await confirmSecondRenewal(
      ledger,
      async () => "AUTHORIZE SECOND SESSION RENEWAL",
      create,
      () => {},
    );
    expect(result.permission.round).toBe(2);
    expect(ledger.state.renewalEvents).toHaveLength(4);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("second renewal refuses partial first renewal or any Storage continuation progress", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { ledger } = await ready();
    const p = continuationCandidate(ledger);
    await new Runner(
      ledger,
      { send: async () => ({ status: 403 }) },
      p,
      p.id,
      false,
    ).send(wrongOwnerIntent());
    vi.setSystemTime(Date.now() + 31 * 60000);
    expect(() => renewalCandidate(ledger, true)).toThrow(
      "CONTINUATION_CHECKPOINT_INVALID",
    );
    const x = haltedCrossRead();
    x.ledger.reconcileCrossRead(reconciliation());
    expect(() => renewalCandidate(x.ledger, true)).toThrow(
      "SECOND_RENEWAL_REQUIRES_COMPLETED_FIRST",
    );
  });
  it("interrupted second renewal is terminal and retains reserved bytes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { ledger } = await ready();
    vi.setSystemTime(Date.now() + 31 * 60000);
    const p = renewalCandidate(ledger, true);
    const send = vi.fn(async () => {
      throw Error("AMBIGUOUS");
    });
    await expect(
      renewSessions(
        ledger,
        p,
        p.id,
        {
          get: (actor) => ({
            ...USERS[actor],
            password: "disposable-fixture-password-32-characters",
          }),
        },
        { send },
        () => {},
      ),
    ).rejects.toThrow("SESSION_RENEWAL_INTERRUPTED");
    expect(send).toHaveBeenCalledTimes(1);
    ledger.load();
    expect(ledger.state.renewalEvents!.at(-1)!.state).toBe("ambiguous");
    expect(() => renewalCandidate(ledger, true)).toThrow();
    expect(() => continuationCandidate(ledger)).toThrow();
    expect(ledger.state.bytes).toBe(474);
  });
  it.each(["before-dispatch", "after-dispatch", "response-read"] as const)(
    "diagnoses %s interruption without assuming delivery or response success",
    async (point) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { ledger, dir } = await ready();
      vi.setSystemTime(Date.now() + 31 * 60000);
      const p = renewalCandidate(ledger, true);
      const fetcher = vi.fn<typeof fetch>(async () => {
        if (point === "after-dispatch") throw Error("fixture timeout");
        return new Response("NOT_JSON_SECRET_FIXTURE", { status: 200 });
      });
      const http = new NativeRenewalHttp(
        "sb_publishable_TEST",
        p,
        p.id,
        () => {
          if (point === "before-dispatch")
            throw Error("fixture local ACL stop");
        },
        ledger,
        fetcher,
      );
      await expect(
        renewSessions(
          ledger,
          p,
          p.id,
          {
            get: (actor) => ({
              ...USERS[actor],
              password: "disposable-fixture-password-32-characters",
            }),
          },
          http,
          () => {},
        ),
      ).rejects.toThrow("SESSION_RENEWAL_INTERRUPTED");
      const before = readFileSync(join(dir, "journal"));
      const result = renewalDiagnostic(ledger);
      const last = result.requests.at(-1)!;
      expect(last.state).toBe("ambiguous");
      expect(last.dispatchMarkerObserved).toBe(point !== "before-dispatch");
      expect(last.durableCompletedResponse).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(
        point === "before-dispatch" ? 0 : 1,
      );
      expect(result.storageContinuationRequests).toBe(0);
      expect(result.attemptedAllocations).toBe(1);
      expect(result.stageBodyBytes).toBe(474);
      expect(result.storageExecutionBlockedByRenewal).toBe(true);
      expect(readFileSync(join(dir, "journal")).equals(before)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(p.id);
      expect(JSON.stringify(result)).not.toContain(
        ledger.state.sessions.A!.token,
      );
      expect(JSON.stringify(result)).not.toContain("NOT_JSON_SECRET_FIXTURE");
    },
  );
  it("native second renewal success records dispatch and completed response for all four requests", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { ledger } = await ready();
    vi.setSystemTime(Date.now() + 31 * 60000);
    const p = renewalCandidate(ledger, true);
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      const e = ledger.state.renewalEvents!.at(-1)!;
      expect(options!.redirect).toBe("error");
      return Response.json(
        e.operation === "login"
          ? { access_token: testToken(e.actor) }
          : { ...USERS[e.actor], role: "authenticated", is_anonymous: false },
      );
    });
    await renewSessions(
      ledger,
      p,
      p.id,
      {
        get: (actor) => ({
          ...USERS[actor],
          password: "disposable-fixture-password-32-characters",
        }),
      },
      new NativeRenewalHttp(
        "sb_publishable_TEST",
        p,
        p.id,
        () => {},
        ledger,
        fetcher,
      ),
      () => {},
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
    const result = renewalDiagnostic(ledger);
    expect(
      result.requests
        .slice(4)
        .every((e) => e.dispatchMarkerObserved && e.durableCompletedResponse),
    ).toBe(true);
    expect(
      result.requests.filter((e) => e.durableIdentityVerification),
    ).toHaveLength(4);
  });
  it("unexpected confirmation or closed terminal cannot authorize requests", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { ledger, dir } = await ready();
    vi.setSystemTime(Date.now() + 31 * 60000);
    const original = readFileSync(join(dir, "journal"));
    const create = vi.fn(() => "DISPOSABLE_ONLY");
    await expect(
      confirmSecondRenewal(
        ledger,
        async () => "unexpected terminal input",
        create,
        () => {},
      ),
    ).rejects.toThrow("SESSION_RENEWAL_NOT_CONFIRMED");
    await expect(
      confirmSecondRenewal(
        ledger,
        async () => {
          throw Error("TERMINAL_CLOSED");
        },
        create,
        () => {},
      ),
    ).rejects.toThrow("TERMINAL_CLOSED");
    expect(create).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "journal")).equals(original)).toBe(true);
  });
  it("completion commit interruption preserves pending evidence without another append", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { ledger, dir } = await ready();
    vi.setSystemTime(Date.now() + 31 * 60000);
    const p = renewalCandidate(ledger, true);
    const originalCommit = ledger.commit.bind(ledger);
    let interruptedJournal: Buffer | undefined;
    vi.spyOn(ledger, "commit").mockImplementation(() => {
      if (
        ledger.state.renewalEvents?.length === 5 &&
        ledger.state.renewalEvents[4].state === "completed"
      ) {
        // Fixture simulates journal fsync + pending before snapshot rename.
        writeFileSync(join(dir, "pending"), "DISPOSABLE_PENDING_EVIDENCE");
        interruptedJournal = readFileSync(join(dir, "journal"));
        throw Error("LOCAL_COMMIT_INTERRUPTION");
      }
      originalCommit();
    });
    const send = vi.fn(async () => ({
      status: 200,
      json: { access_token: testToken("A") },
    }));
    await expect(
      renewSessions(
        ledger,
        p,
        p.id,
        {
          get: (actor) => ({
            ...USERS[actor],
            password: "disposable-fixture-password-32-characters",
          }),
        },
        { send },
        () => {},
      ),
    ).rejects.toThrow("LEDGER_INTEGRITY_RECOVERY_REQUIRED");
    expect(send).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, "pending"), "utf8")).toBe(
      "DISPOSABLE_PENDING_EVIDENCE",
    );
    expect(readFileSync(join(dir, "journal")).equals(interruptedJournal!)).toBe(
      true,
    );
    expect(() => renewalDiagnostic(ledger)).toThrow(
      "LEDGER_INTEGRITY_RECOVERY_REQUIRED",
    );
  });
  it("fully durable Auth response followed by local failure cannot be rewritten as failed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { ledger } = await ready();
    vi.setSystemTime(Date.now() + 31 * 60000);
    const p = renewalCandidate(ledger, true);
    const originalCommit = ledger.commit.bind(ledger);
    vi.spyOn(ledger, "commit").mockImplementation(() => {
      originalCommit();
      if (
        ledger.state.renewalEvents?.length === 5 &&
        ledger.state.renewalEvents[4].state === "completed"
      )
        throw Error("AFTER_DURABLE_COMMIT");
    });
    const send = vi.fn(async () => ({
      status: 200,
      json: { access_token: testToken("A") },
    }));
    await expect(
      renewSessions(
        ledger,
        p,
        p.id,
        {
          get: (actor) => ({
            ...USERS[actor],
            password: "disposable-fixture-password-32-characters",
          }),
        },
        { send },
        () => {},
      ),
    ).rejects.toThrow("SESSION_RENEWAL_POST_COMMIT_STOP");
    expect(send).toHaveBeenCalledTimes(1);
    const result = renewalDiagnostic(ledger);
    expect(result.requests.at(-1)!.durableCompletedResponse).toBe(true);
    expect(result.requests.at(-1)!.durableIdentityVerification).toBe(false);
    expect(result.storageExecutionBlockedByRenewal).toBe(true); // Login is complete; pair still incomplete.
    expect(() => continuationCandidate(ledger)).toThrow(
      "VERIFIED_SESSION_RENEWAL_REQUIRED",
    );
    expect(ledger.state.sessions.A!.token).toBe(
      ledger.state.renewalEvents![1].token,
    );
  });
  it("second renewal refuses expired approval and wrong identity without Storage progress", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { ledger } = await ready();
    vi.setSystemTime(Date.now() + 31 * 60000);
    const p = renewalCandidate(ledger, true);
    const send = vi.fn(async (r: { actor: "A" | "B"; operation: string }) => ({
      status: 200,
      json:
        r.operation === "login"
          ? { access_token: testToken(r.actor) }
          : { ...USERS.B, role: "authenticated", is_anonymous: false },
    }));
    const credentials = {
      get: (actor: "A" | "B") => ({
        ...USERS[actor],
        password: "disposable-fixture-password-32-characters",
      }),
    };
    await expect(
      renewSessions(
        ledger,
        { ...p, expiresAt: new Date(Date.now() - 1).toISOString() },
        p.id,
        credentials,
        { send },
        () => {},
      ),
    ).rejects.toThrow("SESSION_RENEWAL_APPROVAL_REQUIRED");
    expect(send).not.toHaveBeenCalled();
    await expect(
      renewSessions(ledger, p, p.id, credentials, { send }, () => {}),
    ).rejects.toThrow("SESSION_RENEWAL_VERIFICATION_FAILED");
    expect(ledger.state.sessions.A!.token).toBe(
      ledger.state.renewalEvents![1].token,
    );
    expect(ledger.state.entries).toHaveLength(7);
    expect(() => renewalCandidate(ledger, true)).toThrow();
  });
  it("binds fresh approval to renewed checkpoint and exact scope without mutation", async () => {
    const { ledger, dir } = await ready();
    const before = readFileSync(join(dir, "journal"));
    const p = continuationCandidate(ledger);
    expect(p.schemaVersion).toBe(2);
    expect(p.id).toMatch(/^[a-f0-9]{64}$/);
    expect(p.continuation!.stages).toEqual(STAGES.slice(7).map((s) => s.id));
    expect(Date.parse(p.expiresAt) - Date.parse(p.issuedAt!)).toBe(1800000);
    expect(p.continuation!.maxAdditionalBytes).toBe(6292512);
    expect(readFileSync(join(dir, "journal")).equals(before)).toBe(true);
  });
  it("cancellation creates no approval or provider request", async () => {
    const { ledger } = await ready();
    const create = vi.fn(() => "/DISPOSABLE_ONLY");
    await expect(
      confirmContinuation(
        ledger,
        async () => "NO",
        create,
        () => {},
      ),
    ).rejects.toThrow("CONTINUATION_NOT_CONFIRMED");
    expect(create).not.toHaveBeenCalled();
  });
  it("shows target/count/budgets and creates only after exact confirmation", async () => {
    const { ledger } = await ready();
    const question = vi.fn(async () => "EXECUTE TEN STORAGE STAGES"),
      create = vi.fn(() => "/DISPOSABLE_ONLY");
    const result = await confirmContinuation(
      ledger,
      question,
      create,
      () => {},
    );
    expect(question).toHaveBeenCalledWith(CONTINUATION_PROMPT);
    expect(CONTINUATION_PROMPT).toContain(PROJECT);
    expect(CONTINUATION_PROMPT).toContain("10");
    expect(CONTINUATION_PROMPT).toContain("6,292,512");
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.permission.id).not.toBe("");
  });
  it("uses only --execute arguments in-process and never exposes confirmation", async () => {
    const { ledger } = await ready();
    const permission = continuationCandidate(ledger);
    const invoke = vi.fn<typeof runCli>(async () => {});
    await invokePrivateContinuation(
      { ledger, permission, confirmation: permission.id, check: () => {} },
      invoke,
    );
    expect(invoke.mock.calls[0][0]).toEqual(["--execute"]);
    expect(JSON.stringify(invoke.mock.calls[0][0])).not.toContain(
      permission.id,
    );
    expect(invoke.mock.calls[0][1]!.ledger).toBe(ledger);
  });
  it("rejects ACL failure before creating approval", async () => {
    const { ledger } = await ready();
    const create = vi.fn(() => "/DISPOSABLE_ONLY"),
      question = vi.fn(async () => "EXECUTE TEN STORAGE STAGES");
    await expect(
      confirmContinuation(ledger, question, create, () => {
        throw Error("PRIVATE_FILE_ACL_REQUIRED");
      }),
    ).rejects.toThrow("PRIVATE_FILE_ACL_REQUIRED");
    expect(question).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it("rejects expired sessions without renewal or storage retry", async () => {
    const { ledger } = await ready();
    ledger.update((s) => {
      s.sessions.A!.token = testToken("A", true);
    });
    expect(() => continuationCandidate(ledger)).toThrow();
  });
  it("refuses a second invocation after any continuation allocation", async () => {
    const { ledger } = await ready();
    const p = continuationCandidate(ledger);
    await new Runner(
      ledger,
      { send: async () => ({ status: 403 }) },
      p,
      p.id,
      false,
    ).send(wrongOwnerIntent());
    expect(() => continuationCandidate(ledger)).toThrow(
      "CONTINUATION_CHECKPOINT_INVALID",
    );
  });
  it("does not label missing ownership or incomplete TUS as passed", async () => {
    const { ledger } = await ready();
    const r = continuationResult(ledger);
    expect(r.classification).toBe("FIRST WAVE STOPPED / INCOMPLETE");
    expect(r.cleanupExecuted).toBe(false);
    expect(JSON.stringify(r)).not.toContain(ledger.state.sessions.A!.token);
    expect(JSON.stringify(r)).not.toContain(
      ledger.state.renewalEvents![0].approval.id,
    );
  });
  it("revalidates older renewal transitions after new checkpoint", async () => {
    const { ledger, dir, cipher } = await ready();
    const rows = readFileSync(join(dir, "journal"), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const index = rows.findIndex((row) => {
      const s = JSON.parse(cipher.decode(row.cipher));
      return (
        s.renewalEvents?.length === 1 &&
        s.renewalEvents[0].state === "completed"
      );
    });
    const s = JSON.parse(cipher.decode(rows[index].cipher));
    s.sessions.B.token = "UNAUTHORIZED_TRANSIENT_MODIFICATION";
    rows[index].cipher = cipher.encode(JSON.stringify(s));
    let previous = "GENESIS";
    for (const row of rows) {
      row.previous = previous;
      row.digest = hash(
        JSON.stringify({
          generation: row.generation,
          previous: row.previous,
          cipher: row.cipher,
        }),
      );
      previous = row.digest;
    }
    writeFileSync(
      join(dir, "journal"),
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    writeFileSync(join(dir, "snapshot"), JSON.stringify(rows.at(-1)));
    ledger.load();
    expect(() => continuationCandidate(ledger)).toThrow(
      "SESSION_RENEWAL_HISTORY_INVALID",
    );
  });
});
