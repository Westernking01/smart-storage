import type { Pool } from "pg";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  pool: vi.fn(),
  owner: vi.fn(),
  config: vi.fn(),
}));
vi.mock(
  "../../src/lib/backend/development-publisher-postgres.server",
  async (original) => ({
    ...(await original<
      typeof import("../../src/lib/backend/development-publisher-postgres.server")
    >()),
    publisherPool: mocks.pool,
  }),
);
vi.mock("../../src/lib/backend/operations", async (original) => ({
  ...(await original<typeof import("../../src/lib/backend/operations")>()),
  ownerContext: mocks.owner,
}));
vi.mock("../../src/lib/backend/development-cloud-config", () => ({
  developmentCloudConfig: mocks.config,
}));
import {
  developmentCloudPostgresAuthority,
  developmentCloudRuntime,
} from "../../src/lib/backend/development-cloud.server";
import { GET } from "../../src/app/api/development-cloud/route";

const id = "00000000-0000-4000-8000-000000000123";
const other = "00000000-0000-4000-8000-000000000124";
const config = {
  project: "fneuqneqaopkmpeevlqz",
  environment: "development",
  url: "https://fneuqneqaopkmpeevlqz.supabase.co",
  key: "fixture",
  origin: "http://localhost:3000",
  bucket: "fixture",
  permitKey: "a".repeat(64),
  maximumBytes: 6291456,
} as const;
function fixture(owner = id) {
  const user = {
    id: owner,
    role: "authenticated",
    is_anonymous: false,
    email_confirmed_at: "2026-01-01",
  };
  const claims = {
    sub: owner,
    role: "authenticated",
    is_anonymous: false,
    iss: `${config.url}/auth/v1`,
    exp: Date.now() / 1000 + 3600,
  };
  const auth = {
    getSession: vi.fn(async () => ({
      data: { session: { access_token: "fixture.payload.signature" } },
      error: null,
    })),
    getUser: vi.fn(async () => ({ data: { user }, error: null })),
    getClaims: vi.fn(async () => ({ data: { claims }, error: null })),
  };
  const bucket = vi.fn(async () => ({
    data: {
      id: config.bucket,
      public: false,
      file_size_limit: 6291456,
      allowed_mime_types: ["application/octet-stream"],
    },
    error: null,
  }));
  const context = {
    id: owner,
    client: { auth, storage: { getBucket: bucket } },
  } as unknown as Parameters<typeof developmentCloudPostgresAuthority>[0];
  return { context, auth, user, claims, bucket };
}
function database() {
  const clients: ReturnType<typeof client>[] = [];
  function client() {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      if (sql.includes("AS enrolled"))
        return {
          rows: [
            {
              login: "ss_dev_cloud_publisher_login",
              role: "ss_dev_cloud_publisher",
              read_only: "on",
              context_matches: true,
              legacy_clear: true,
              enrolled: true,
            },
          ],
        };
      if (sql.includes("AS clean"))
        return {
          rows: [
            {
              login: "ss_dev_cloud_publisher_login",
              role: "ss_dev_cloud_publisher_login",
              clean: true,
            },
          ],
        };
      return {
        rows: [{ login: "ss_dev_cloud_publisher_login", result: null }],
      };
    });
    return { query, release: vi.fn() };
  }
  const connect = vi.fn(async () => {
    const c = client();
    clients.push(c);
    return c;
  });
  const db = { connect } as unknown as Pick<Pool, "connect">;
  mocks.pool.mockReturnValue(db);
  return { db, connect, clients };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  mocks.config.mockReturnValue(config);
});
afterEach(() => vi.unstubAllEnvs());

it("keeps disabled runtime ahead of Auth and pool creation even with postgres selected", async () => {
  vi.stubEnv("SMART_STORAGE_DEV_CLOUD_PUBLISHER", "postgres");
  mocks.config.mockReturnValue(null);
  await expect(developmentCloudRuntime()).rejects.toThrow("DEV_CLOUD_DISABLED");
  expect(mocks.owner).not.toHaveBeenCalled();
  expect(mocks.pool).not.toHaveBeenCalled();
});
it.each(["wrong-owner", "invalid-session", "production"])(
  "rejects %s before pool construction",
  async (kind) => {
    const f = fixture();
    if (kind === "wrong-owner") f.context.id = other;
    if (kind === "invalid-session") f.claims.exp = 1;
    if (kind === "production") vi.stubEnv("NODE_ENV", "production");
    await expect(
      developmentCloudPostgresAuthority(f.context, config, "fixture"),
    ).rejects.toThrow("CLOUD_TRUSTED_RPC_UNAVAILABLE");
    expect(mocks.pool).not.toHaveBeenCalled();
  },
);
it("retains independent bucket authorization before constructing PostgreSQL authority", async () => {
  const f = fixture();
  database();
  mocks.owner.mockResolvedValue(f.context);
  vi.stubEnv("SMART_STORAGE_DEV_CLOUD_PUBLISHER", "postgres");
  f.bucket.mockRejectedValue(Error("private diagnostic"));
  const response = await GET(
    new Request("http://localhost:3000/api/development-cloud"),
  );
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private diagnostic");
  expect(mocks.pool).not.toHaveBeenCalled();
});
it("selects postgres explicitly and masks initialization errors through the actual route", async () => {
  const f = fixture();
  mocks.owner.mockResolvedValue(f.context);
  vi.stubEnv("SMART_STORAGE_DEV_CLOUD_PUBLISHER", "postgres");
  mocks.pool.mockImplementation(() => {
    throw Error("private connection string");
  });
  const response = await GET(
    new Request("http://localhost:3000/api/development-cloud"),
  );
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("CLOUD_TRUSTED_RPC_UNAVAILABLE");
  expect(f.bucket).toHaveBeenCalledOnce();
});
it("denies disabled enrollment and destroys its checkout without publication", async () => {
  const f = fixture(),
    d = database();
  d.connect.mockImplementationOnce(async () => {
    const c = {
      query: vi.fn(async (sql: string) => ({
        rows: [
          {
            login: "ss_dev_cloud_publisher_login",
            role: "ss_dev_cloud_publisher",
            read_only: "on",
            context_matches: true,
            legacy_clear: true,
            enrolled: !sql.includes("AS enrolled"),
          },
        ],
      })),
      release: vi.fn(),
    };
    d.clients.push(c);
    return c;
  });
  const a = await developmentCloudPostgresAuthority(
    f.context,
    config,
    "fixture",
  );
  await expect(a.ensureTrusted()).rejects.toThrow(
    "CLOUD_TRUSTED_RPC_UNAVAILABLE",
  );
  expect(d.clients[0].release).toHaveBeenCalledWith(true);
  expect(
    d.clients[0].query.mock.calls.some(
      ([sql]) =>
        sql.includes("COMMIT") || sql.startsWith("SELECT public.ss_finish"),
    ),
  ).toBe(false);
});
it("isolates simultaneous owner checkouts and parameterized claims", async () => {
  const d = database(),
    a = fixture(),
    b = fixture(other);
  const authorities = await Promise.all(
    [a, b].map((f) =>
      developmentCloudPostgresAuthority(f.context, config, "fixture"),
    ),
  );
  await Promise.all(authorities.map((x) => x.ensureTrusted()));
  expect(d.connect).toHaveBeenCalledTimes(2);
  for (const [index, owner] of [id, other].entries()) {
    const c = d.clients[index];
    const values = c.query.mock.calls.find(([sql]) =>
      sql.includes("set_config"),
    )?.[1];
    expect(values).toEqual([
      JSON.stringify({
        sub: owner,
        role: "ss_dev_cloud_publisher",
        is_anonymous: false,
      }),
    ]);
    expect(c.release).toHaveBeenCalledWith(false);
  }
});
it.each(["rollback", "release", "connect", "changed-user"])(
  "masks %s failure without retry",
  async (stage) => {
    const f = fixture(),
      d = database();
    const a = await developmentCloudPostgresAuthority(
      f.context,
      config,
      "fixture",
    );
    d.connect.mockImplementationOnce(async () => {
      if (stage === "connect") throw Error("secret");
      if (stage === "changed-user") {
        f.user.id = other;
        f.claims.sub = other;
      }
      const c = {
        query: vi.fn(async (sql: string) => {
          if (stage === "rollback" && sql === "ROLLBACK") throw Error("secret");
          return {
            rows: [
              {
                login: "ss_dev_cloud_publisher_login",
                role: sql.includes("AS clean")
                  ? "ss_dev_cloud_publisher_login"
                  : "ss_dev_cloud_publisher",
                read_only: "on",
                context_matches: true,
                legacy_clear: true,
                enrolled: true,
                clean: true,
              },
            ],
          };
        }),
        release: vi.fn(() => {
          if (stage === "release") throw Error("secret");
        }),
      };
      d.clients.push(c);
      return c;
    });
    await expect(a.ensureTrusted()).rejects.toThrow(
      /^CLOUD_TRUSTED_RPC_UNAVAILABLE$/,
    );
    expect(d.connect).toHaveBeenCalledOnce();
    if (stage !== "connect")
      expect(
        d.clients[0].query.mock.calls.some(([sql]) => sql === "COMMIT"),
      ).toBe(false);
  },
);

it("revalidates the owner after waiting for a checkout", async () => {
  const f = fixture(),
    d = database();
  const a = await developmentCloudPostgresAuthority(
    f.context,
    config,
    "fixture",
  );
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const connect = d.connect.getMockImplementation()!;
  d.connect.mockImplementationOnce(async () => {
    entered();
    await gate;
    return connect();
  });
  const result = a.ensureTrusted();
  await waiting;
  f.claims.exp = 1;
  unlock();
  await expect(result).rejects.toThrow("CLOUD_TRUSTED_RPC_UNAVAILABLE");
  expect(d.clients[0].release).toHaveBeenCalledWith(true);
  expect(
    d.clients[0].query.mock.calls.some(([sql]) => sql.includes("set_config")),
  ).toBe(false);
});
it.each(["", "jwt"])(
  "preserves the existing authority for selection '%s'",
  async (selection) => {
    const f = fixture();
    mocks.owner.mockResolvedValue(f.context);
    vi.stubEnv("SMART_STORAGE_DEV_CLOUD_PUBLISHER", selection);
    await expect(developmentCloudRuntime()).resolves.toBeDefined();
    expect(mocks.pool).not.toHaveBeenCalled();
  },
);
it("rejects unknown selections without constructing a pool or falling back", async () => {
  const f = fixture();
  mocks.owner.mockResolvedValue(f.context);
  vi.stubEnv("SMART_STORAGE_DEV_CLOUD_PUBLISHER", "unknown");
  await expect(developmentCloudRuntime()).rejects.toThrow(
    "CLOUD_TRUSTED_RPC_UNAVAILABLE",
  );
  expect(mocks.pool).not.toHaveBeenCalled();
});
it("masks publisher checkout errors through the selected authority", async () => {
  const f = fixture(),
    d = database();
  const a = await developmentCloudPostgresAuthority(
    f.context,
    config,
    "fixture",
  );
  d.connect.mockRejectedValue(Error("private connection string"));
  await expect(
    a.trusted("ss_finish_attempt_request", { p_request: id, p_offset: null }),
  ).rejects.toThrow(/^CLOUD_TRUSTED_RPC_UNAVAILABLE$/);
  expect(d.connect).toHaveBeenCalledOnce();
});
