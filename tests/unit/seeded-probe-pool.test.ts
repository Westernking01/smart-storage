import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
const pg = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [{ ok: true }] })),
  release: vi.fn(),
  options: vi.fn(),
}));
vi.mock("pg", () => ({
  Pool: class {
    constructor(options: unknown) {
      pg.options(options);
    }
    on() {}
    async connect() {
      return { query: pg.query, release: pg.release };
    }
  },
}));
import { createLocalPool } from "../../experiments/storage/seeded-probe-host-cli";
describe("pinned local PostgreSQL adapter", () => {
  it("uses explicit loopback/role/password with bounded connections and no defaults", () => {
    createLocalPool("ss_gateway_observer_runtime_test", "mock-only");
    expect(pg.options).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 5432,
        database: "smart_storage_gateway_test",
        user: "ss_gateway_observer_runtime_test",
        password: "mock-only",
        ssl: false,
        max: 1,
        connectionTimeoutMillis: 10000,
        statement_timeout: 10000,
        lock_timeout: 5000,
      }),
    );
  });
  it("passes real bind parameters unchanged and discards failed clients", async () => {
    const { adapter } = createLocalPool("postgres", "mock-only");
    const client = await adapter.connect();
    const values = ["not SQL: ' ; --"];
    await client.query("SELECT $1::text", values);
    expect(pg.query).toHaveBeenLastCalledWith("SELECT $1::text", values);
    const failure = Error("uncertain commit");
    client.release(failure);
    expect(pg.release).toHaveBeenLastCalledWith(failure);
  });
  it("rejects empty passwords instead of environment/passfile fallback", () => {
    expect(() => createLocalPool("postgres", "")).toThrow(
      "DATABASE_INPUT_REJECTED",
    );
  });
});
