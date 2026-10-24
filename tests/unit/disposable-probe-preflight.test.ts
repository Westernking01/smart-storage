import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { preflightDisposableProbe } from "../../src/lib/gateway/disposable-probe-preflight.server";
import type { ProbeTarget } from "../../src/lib/gateway/inspection-runner.server";
import configTemplate from "../../experiments/storage/disposable-probe.config.template.json";
import authorizationTemplate from "../../experiments/storage/disposable-probe.authorization.template.json";
const destinations = {
  observer: "postgresql://127.0.0.1:5432/smart_storage_gateway_test",
  observerRole: "ss_gateway_observer_runtime_test",
  evidenceDirectory: "C:\\private\\probe",
  restrictedAclReviewed: true,
};
const c = {
  enabled: true,
  project: "rrylhvqalsxjnkdkpwde",
  endpoint: "https://rrylhvqalsxjnkdkpwde.supabase.co/storage/v1",
  bucket: "smart-storage-gateway-probe",
  privateBucket: true,
  prefix: "gateway-probe/v1/",
  key: "gateway-probe/v1/probe-fixture-v1.txt",
  userId: "310d0ec8-84ca-423a-b646-0480a20edc09",
  expectedBytes: 3,
  expectedSha256: "a".repeat(64),
  independentFixtureVerification: "operator local length/hash record",
  destinations,
};
const { enabled: _enabled, ...s } = c;
void _enabled;
const a = {
  ...s,
  authorizationId: "00000000-0000-4000-8000-000000000001",
  issuedAt: 1000,
  expiresAt: 61000,
  readOnly: true,
  operations: { metadata: 1, hash: 1, list: 1 },
  maximumResponseBodyBytesPerOperation: 65536,
  maximumListEntries: 100,
  timeoutMs: 30000,
  retries: 0,
  redirects: 0,
  accounting: "accepted-raw-response-body",
  physicalOverheadUnboundedAcknowledged: true,
};
const t = {
  project: c.project,
  endpoint: c.endpoint,
  prefix: "gateway-probe/v1",
  intent: {
    ownerId: c.userId,
    bucket: c.bucket,
    path: c.key,
    declaredBytes: 3,
    expectedSha256: c.expectedSha256,
  },
} as ProbeTarget;
const run = (
  config: unknown = c,
  auth: unknown = a,
  target = t,
  dest: unknown = destinations,
  op = "hash",
  now = 2000,
) => preflightDisposableProbe(config, auth, target, dest, op, now);
describe("disposable probe local preflight", () => {
  it("ships disabled, incomplete templates that cannot authorize a request", () => {
    expect(configTemplate.enabled).toBe(false);
    expect(() => run(configTemplate, authorizationTemplate)).toThrow();
    expect(() =>
      run({ ...configTemplate, enabled: true }, authorizationTemplate),
    ).toThrow();
  });
  it.each(Object.keys(a))("requires authorization field %s", (field) => {
    const incomplete = { ...a } as Record<string, unknown>;
    delete incomplete[field];
    expect(() => run(c, incomplete)).toThrow();
  });
  it.each([
    { observerRole: "postgres" },
    { observer: "postgresql://127.0.0.1:5432/postgres" },
    { evidenceDirectory: "relative" },
    { evidenceDirectory: "\\\\server\\share" },
    { restrictedAclReviewed: false },
  ])("rejects unrestricted destination %j", (patch) => {
    const invalid = { ...destinations, ...patch };
    expect(() =>
      run(
        { ...c, destinations: invalid },
        { ...a, destinations: invalid },
        t,
        invalid,
      ),
    ).toThrow();
  });
  it("returns only runner authorization without I/O", () =>
    expect(run()).toMatchObject({ target: t, accounting: a.accounting }));
  it.each([
    "project",
    "endpoint",
    "bucket",
    "privateBucket",
    "prefix",
    "key",
    "expectedBytes",
    "expectedSha256",
    "independentFixtureVerification",
    "destinations",
  ])("requires %s", (field) => {
    const v = { ...c } as Record<string, unknown>;
    delete v[field];
    expect(() => run(v)).toThrow();
  });
  it.each([
    { expiresAt: 2000 },
    { issuedAt: 3000 },
    { expiresAt: 1801001 },
    { operations: { metadata: 1, hash: 2, list: 1 } },
    { operations: { delete: 1 } },
    { accounting: "physical-network-bytes" },
    { physicalOverheadUnboundedAcknowledged: false },
    { expectedBytes: 4 },
    { expectedSha256: "b".repeat(64) },
    { project: "fneuqneqaopkmpeevlqz" },
    { endpoint: c.endpoint + "/" },
    { privateBucket: false },
    { key: "gateway-probe/v1/../x.bin" },
  ])("rejects invalid authority %j", (patch) =>
    expect(() => run(c, { ...a, ...patch })).toThrow(),
  );
  it("defaults disabled and rejects other destinations/operations/target", () => {
    const { enabled, ...disabled } = c;
    void enabled;
    expect(() => run(disabled)).toThrow("PROBE_DISABLED");
    expect(() =>
      run(c, a, { ...t, project: "fneuqneqaopkmpeevlqz" }),
    ).toThrow();
    expect(() =>
      run(c, a, t, { ...destinations, evidenceDirectory: "C:\\other" }),
    ).toThrow();
    expect(() => run(c, a, t, destinations, "delete")).toThrow();
  });
});
