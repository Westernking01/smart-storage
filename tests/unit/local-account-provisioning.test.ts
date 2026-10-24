import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../../src/lib/supabase/server", () => ({ serverSupabase: vi.fn() }));
import {
  LOCAL_AUTH_ISSUER,
  provisioningManifest,
} from "../../src/lib/backend/local-account-provisioning.server";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const provider = LOCAL_AUTH_ISSUER.replace(/\/auth\/v1$/, "");
const allocation = { quotaBytes: "262144", maxSlots: 1 };
it("verifies freshly, denies invalid identities and emits no Auth secrets", async () => {
  const user = {
    id: B,
    role: "authenticated",
    is_anonymous: false,
    email_confirmed_at: "2026-01-01T00:00:00Z",
    email: "fixture@example.invalid",
  };
  const getUser = vi.fn(async () => ({ data: { user }, error: null }));
  expect(
    await provisioningManifest(provider, { auth: { getUser } }, allocation),
  ).toEqual({ issuer: LOCAL_AUTH_ISSUER, subject: B, ...allocation });
  await expect(
    provisioningManifest(
      "https://wrong.example.invalid",
      { auth: { getUser } },
      allocation,
    ),
  ).rejects.toThrow("ISSUER_DENIED");
  expect(getUser).toHaveBeenCalledTimes(1);
  for (const invalid of [
    null,
    { ...user, is_anonymous: true },
    { ...user, role: "service_role" },
    { ...user, email_confirmed_at: null },
    { ...user, id: "bad" },
  ]) {
    await expect(
      provisioningManifest(
        provider,
        {
          auth: {
            getUser: async () => ({ data: { user: invalid }, error: null }),
          },
        },
        allocation,
      ),
    ).rejects.toThrow("IDENTITY_DENIED");
  }
  await expect(
    provisioningManifest(
      provider,
      { auth: { getUser: async () => ({ data: { user }, error: {} }) } },
      allocation,
    ),
  ).rejects.toThrow("IDENTITY_DENIED");
});

let db: PGlite;
let historical: unknown[];
const provision = (id: string, quota = "262144") =>
  db.query("select app_private.provision_local_account($1,$2,$3,1)", [
    LOCAL_AUTH_ISSUER,
    id,
    quota,
  ]);
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create role ss_volume_runtime noinherit;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema auth to anon,authenticated,service_role;
    insert into auth.users values('${A}');`);
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const name of (await readdir(dir))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await db.exec(
      (await readFile(new URL(name, dir), "utf8")).replace(/^\uFEFF/, ""),
    );
  await db.exec(`insert into public.profiles(id) values('${A}');
    insert into public.user_usage(owner_id,quota_bytes,reserved_bytes,active_slots,max_slots)
    values('${A}',900000,123456,1,2);`);
  await db.exec(`insert into auth.users select md5('historical-fixture-'||i)::uuid from generate_series(1,137) i;
    insert into public.profiles(id) select id from auth.users where id<>'${A}';
    insert into public.user_usage(owner_id,quota_bytes,reserved_bytes,active_slots,max_slots)
    select id,900000,123456,1,2 from auth.users where id<>'${A}';`);
  historical = (await db.query("select * from public.user_usage")).rows;
  // Only the database-name gate is adapted for this in-memory disposable database.
  const sql = (
    await readFile(
      new URL("../../docs/local-account-provisioning.sql", import.meta.url),
      "utf8",
    )
  ).replace(
    "current_database()<>'smart_storage_gateway_test'",
    "current_database()<>'postgres'",
  );
  await db.exec(sql);
}, 120000);
afterAll(async () => {
  await db?.close();
});

it("preserves historical liabilities and global zero policy; rejects historical collision", async () => {
  expect((await db.query("select * from public.user_usage")).rows).toEqual(
    historical,
  );
  expect(
    (
      await db.query(
        "select quota_bytes,max_slots from app_private.account_policy",
      )
    ).rows,
  ).toEqual([{ quota_bytes: 0, max_slots: 0 }]);
  await expect(provision(A)).rejects.toThrow("PRINCIPAL_COLLISION");
  expect(
    (
      await db.query(
        "select state from app_private.local_principals where id=$1",
        [A],
      )
    ).rows,
  ).toEqual([{ state: "historical_unmapped" }]);
});
it("creates atomically, repeats exactly, rejects quota changes and serializes queued duplicates", async () => {
  await Promise.all([provision(B), provision(B)]);
  await provision(B);
  await expect(provision(B, "524288")).rejects.toThrow("STATE_CONFLICT");
  expect(
    (
      await db.query(
        "select count(*)::int n from public.profiles where id=$1",
        [B],
      )
    ).rows,
  ).toEqual([{ n: 1 }]);
  expect(
    (await db.query("select * from public.user_usage where owner_id<>$1", [B]))
      .rows,
  ).toEqual(historical);
});
it("rejects partial states without repairing them", async () => {
  await db.query(
    "insert into app_private.local_principals values($1,$2,$1,'active',262144,1)",
    [C, LOCAL_AUTH_ISSUER],
  );
  await expect(provision(C)).rejects.toThrow("STATE_CONFLICT");
  expect(
    (
      await db.query(
        "select count(*)::int n from public.profiles where id=$1",
        [C],
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
});

it("rolls back all creation when a usage insert fails", async () => {
  const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  await db.exec(`create function app_private.fixture_reject_usage() returns trigger language plpgsql as $$ begin raise exception 'FIXTURE_FAILURE'; end $$;
    create trigger fixture_reject before insert on public.user_usage for each row execute function app_private.fixture_reject_usage();`);
  try {
    await expect(provision(id)).rejects.toThrow("FIXTURE_FAILURE");
    expect(
      (
        await db.query(
          "select count(*)::int n from app_private.local_principals where id=$1",
          [id],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    expect(
      (
        await db.query(
          "select count(*)::int n from public.profiles where id=$1",
          [id],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  } finally {
    await db.exec(
      "drop trigger fixture_reject on public.user_usage; drop function app_private.fixture_reject_usage()",
    );
  }
});
it("denies runtime provisioning/table access and fences lifecycle commands by issuer/state", async () => {
  for (const role of [
    "ss_volume_runtime",
    "ss_volume_gateway",
    "authenticated",
  ]) {
    expect(
      (
        await db.query(
          "select has_function_privilege($1,'app_private.provision_local_account(text,uuid,bigint,integer)','execute') ok",
          [role],
        )
      ).rows,
    ).toEqual([{ ok: false }]);
    expect(
      (
        await db.query(
          "select has_table_privilege($1,'app_private.local_principals','SELECT,INSERT,UPDATE,DELETE') ok",
          [role],
        )
      ).rows,
    ).toEqual([{ ok: false }]);
  }
  await db.exec("begin; set local role ss_volume_gateway");
  await db.query("select set_config('smart_storage.local_issuer',$1,true)", [
    LOCAL_AUTH_ISSUER,
  ]);
  expect(
    (
      await db.query(
        "select public.ss_volume_command($1,'binding',null,'{}') ok",
        [B],
      )
    ).rows,
  ).toEqual([{ ok: true }]);
  await db.exec("rollback; begin; set local role ss_volume_gateway");
  await expect(
    db.query("select app_private.provision_local_account($1,$2,262144,1)", [
      LOCAL_AUTH_ISSUER,
      B,
    ]),
  ).rejects.toThrow();
  await db.exec("rollback; begin; set local role ss_volume_gateway");
  await db.query(
    "select set_config('smart_storage.local_issuer','https://wrong.example.invalid/auth/v1',true)",
  );
  await expect(
    db.query("select public.ss_volume_command($1,'binding',null,'{}')", [B]),
  ).rejects.toThrow("ACCOUNT_SETUP_REQUIRED");
  await db.exec("rollback; begin; set local role ss_volume_gateway");
  await expect(
    db.query("select public.ss_volume_command($1,'list',null,'{}')", [A]),
  ).rejects.toThrow("ACCOUNT_SETUP_REQUIRED");
  await db.exec("rollback");
  await db.query(
    "update app_private.local_principals set state='revoked' where id=$1",
    [B],
  );
  await db.query("select set_config('smart_storage.local_issuer',$1,false)", [
    LOCAL_AUTH_ISSUER,
  ]);
  await expect(
    db.query("select public.ss_volume_command($1,'binding',null,'{}')", [B]),
  ).rejects.toThrow("ACCOUNT_SETUP_REQUIRED");
});
