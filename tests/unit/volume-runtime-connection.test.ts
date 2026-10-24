import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../../src/lib/gateway/volume-runtime.server";

const mocked = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  pool: vi.fn(),
  lstat: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("pg", () => ({
  Pool: class {
    constructor(options: unknown) {
      mocked.pool(options);
    }
    async connect() {
      return { query: mocked.query, release: mocked.release };
    }
  },
}));
vi.mock("node:fs/promises", () => ({
  lstat: mocked.lstat,
  readFile: async () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const [key, value] of Object.entries({
    SMART_STORAGE_LOCAL_VOLUME_ENABLED: "true",
    SMART_STORAGE_BACKEND_ENABLED: "true",
    SMART_STORAGE_TRANSFERS_ENABLED: "false",
    SMART_STORAGE_ENV: "development",
    APP_ORIGIN: "http://localhost:3000",
    NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      "sb_publishable_local_test_placeholder",
    SMART_STORAGE_LOCAL_VOLUME_ROOT: "C:/private-volume-fixture",
    SMART_STORAGE_LOCAL_VOLUME_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    SMART_STORAGE_LOCAL_DATABASE_URL:
      "postgresql://ss_volume_runtime@127.0.0.1:5432/smart_storage_gateway_test",
  }))
    vi.stubEnv(key, value);
  mocked.lstat.mockResolvedValue({
    isDirectory: () => true,
    isSymbolicLink: () => false,
  });
  mocked.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("as allowed")
      ? [{ allowed: true }]
      : [{ value: sql.includes("'binding'") ? true : [] }],
  }));
});
afterEach(() => vi.unstubAllEnvs());

it("rejects the old database, remote hosts and alternative logins before I/O", async () => {
  const { volumeRuntime } =
    await import("../../src/lib/gateway/volume-runtime.server");
  for (const url of [
    "postgresql://ss_volume_runtime@127.0.0.1/smart_storage_volume_local",
    "postgresql://ss_volume_runtime@remote.example.invalid/smart_storage_gateway_test",
    "postgresql://postgres@127.0.0.1/smart_storage_gateway_test",
  ]) {
    vi.stubEnv("SMART_STORAGE_LOCAL_DATABASE_URL", url);
    await expect(volumeRuntime()).rejects.toThrow(
      "LOCAL_VOLUME_CONFIGURATION_INVALID",
    );
  }
  expect(mocked.pool).not.toHaveBeenCalled();
  expect(mocked.lstat).not.toHaveBeenCalled();
});

it("checks the exact database before a transaction-local role switch and bound owner command", async () => {
  const { volumeRuntime } =
    await import("../../src/lib/gateway/volume-runtime.server");
  const runtime = await volumeRuntime();
  const owner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await runtime.list(owner);
  const calls = mocked.query.mock.calls;
  expect(calls[0][0]).toBe("begin isolation level read committed");
  expect(calls[1][0]).toContain(
    "current_database()='smart_storage_gateway_test'",
  );
  expect(calls[1][0]).toContain("session_user='ss_volume_runtime'");
  expect(calls[2][0]).toBe("set local role ss_volume_gateway");
  expect(calls[3][0]).toContain("set_config('smart_storage.local_issuer'");
  expect(calls[3][1]).toEqual(["http://localhost:54321/auth/v1"]);
  expect(calls[4][1]).toEqual([owner]);
  expect(calls[5][0]).toBe(
    "select public.ss_volume_command($1,$2,$3,$4::jsonb) value",
  );
  expect(calls[5][1][0]).toBe(owner);
  expect(calls[6][0]).toBe("commit");
  expect(mocked.release).toHaveBeenCalledWith(undefined);
});

it("rejects an unmapped principal before lifecycle commands and rolls back", async () => {
  mocked.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("as allowed") ? [{ allowed: true }] : [{ value: false }],
  }));
  const { volumeRuntime } =
    await import("../../src/lib/gateway/volume-runtime.server");
  await expect(
    (await volumeRuntime()).list("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
  ).rejects.toThrow("ACCOUNT_SETUP_REQUIRED");
  expect(
    mocked.query.mock.calls.some(([sql]) => sql.includes("$4::jsonb")),
  ).toBe(false);
  expect(mocked.query).toHaveBeenLastCalledWith("rollback");
});

it("fails closed on a rejected database identity and discards the connection", async () => {
  mocked.query.mockImplementation(async () => ({ rows: [{ allowed: false }] }));
  const { volumeRuntime } =
    await import("../../src/lib/gateway/volume-runtime.server");
  const runtime = await volumeRuntime();
  await expect(
    runtime.list("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
  ).rejects.toThrow("RESTRICTED_RUNTIME_REQUIRED");
  expect(mocked.query.mock.calls.map(([sql]) => sql)).not.toContain(
    "set local role ss_volume_gateway",
  );
  expect(mocked.query).toHaveBeenLastCalledWith("rollback");
  expect(mocked.release).toHaveBeenCalledWith(expect.any(Error));
});
