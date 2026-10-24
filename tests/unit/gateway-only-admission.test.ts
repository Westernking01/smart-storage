import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const H = "a".repeat(64);
let db: PGlite;
async function call<T>(
  role: string,
  owner: string,
  sql: string,
  args: unknown[] = [],
) {
  await db.exec("savepoint invocation");
  try {
    // Roles are fixed test constants, never caller input.
    await db.exec(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: owner, role: "authenticated" }),
    ]);
    const result = await db.query<T>(sql, args);
    await db.exec("reset role; release savepoint invocation");
    return result.rows;
  } catch (error) {
    await db.exec(
      "rollback to savepoint invocation; release savepoint invocation",
    );
    throw error;
  }
}
async function reserve(owner = A, key = "reservation_key_0001") {
  const rows = await call<{
    value: { id: string; fileId: string; heldBytes: string };
  }>(
    "authenticated",
    owner,
    "select public.ss_reserve($1,'file.bin',null,100,$2) value",
    [key, H],
  );
  return rows[0].value;
}
async function allocate(session: string) {
  const rows = await call<{ value: { id: string } }>(
    "authenticated",
    A,
    "select public.ss_allocate_attempt($1,0,100,30,'gzip',$2,$2) value",
    [session, H],
  );
  return rows[0].value.id;
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema auth to anon,authenticated,service_role;
    insert into auth.users values('${A}'),('${B}');`);
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const name of (await readdir(dir))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await db.exec(
      (await readFile(new URL(name, dir), "utf8")).replace(/^\uFEFF/, ""),
    );
  await db.exec("begin");
  for (const owner of [A, B])
    await call("authenticated", owner, "select public.ss_bootstrap()");
  await db.exec(`update public.user_usage set quota_bytes=262344,max_slots=2;
    insert into app_private.gateway_accounts(owner_id,max_active_streams,bucket) values('${A}',2,'private'); commit;`);
}, 120000);
beforeEach(async () => {
  await db.exec("begin");
});
afterEach(async () => {
  await db.exec("rollback");
});
afterAll(async () => {
  await db?.close();
});

it("atomically enrolls authenticated reservations with owner binding and idempotent accounting", async () => {
  const session = await reserve();
  expect(await reserve()).toEqual(session);
  const rows = await db.query(
    "select owner_id,contract_version from app_private.gateway_sessions where session_id=$1",
    [session.id],
  );
  expect(rows.rows).toEqual([{ owner_id: A, contract_version: 1 }]);
  expect(
    (
      await db.query(
        "select reserved_bytes,active_slots from public.user_usage where owner_id=$1",
        [A],
      )
    ).rows,
  ).toEqual([{ reserved_bytes: 131172, active_slots: 1 }]);
  expect(
    (
      await db.query(
        "select count(*)::int n from public.usage_events where session_id=$1",
        [session.id],
      )
    ).rows[0],
  ).toEqual({ n: 1 });
  await expect(
    call(
      "authenticated",
      B,
      "select public.ss_allocate_attempt($1,0,100,30,'gzip',$2,$2)",
      [session.id, H],
    ),
  ).rejects.toThrow("NOT_FOUND");
});

it("fails the whole reservation closed when enrollment fails", async () => {
  await db.exec(`create function app_private.test_reject_enrollment() returns trigger language plpgsql as $$
    begin raise exception 'TEST_ENROLLMENT_FAILURE'; end $$;
    create trigger test_reject_enrollment before insert on app_private.gateway_sessions
    for each row execute function app_private.test_reject_enrollment();`);
  await expect(reserve()).rejects.toThrow("TEST_ENROLLMENT_FAILURE");
  for (const table of ["files", "upload_sessions", "usage_events"])
    expect(
      (await db.query(`select count(*)::int n from public.${table}`)).rows[0],
    ).toEqual({ n: 0 });
  expect(
    (
      await db.query(
        "select reserved_bytes,active_slots from public.user_usage where owner_id=$1",
        [A],
      )
    ).rows[0],
  ).toEqual({ reserved_bytes: 0, active_slots: 0 });
});

it("retains atomic near-quota admission without duplicate reservations", async () => {
  await reserve();
  await reserve(A, "reservation_key_0002");
  await expect(reserve(A, "reservation_key_0003")).rejects.toThrow(
    "QUOTA_EXCEEDED",
  );
  expect(
    (await db.query("select count(*)::int n from app_private.gateway_sessions"))
      .rows[0],
  ).toEqual({ n: 2 });
});

it("keeps holds through cancellation and blocks weaker proof transitions before the first claim", async () => {
  const session = await reserve();
  const attempt = await allocate(session.id);
  // Exercise the existing guards as the trusted migration owner, independently
  // of the runtime ACL denial. Enrollment must already exist before any claim.
  await expect(
    call("postgres", A, "select public.ss_record_observation($1,1,30)", [
      attempt,
    ]),
  ).rejects.toThrow("EVIDENCE_REQUIRED");
  await call("authenticated", A, "select public.ss_cancel($1)", [session.id]);
  await expect(
    call("postgres", A, "select public.ss_settle_cleanup($1,true,true)", [
      session.id,
    ]),
  ).rejects.toThrow("GATEWAY_V1_REQUIRED");
  expect(
    (
      await db.query(
        "select reserved_bytes,active_slots from public.user_usage where owner_id=$1",
        [A],
      )
    ).rows[0],
  ).toEqual({ reserved_bytes: 131172, active_slots: 1 });
});

it("claims the actual encoded descriptor length, rejects original size and cross-owner claims, and fences replay", async () => {
  const session = await reserve();
  const attempt = await allocate(session.id);
  const claim = (owner: string, bytes: number) =>
    call<{ value: { kind: string } }>(
      "ss_gateway_executor",
      owner,
      "select public.ss_gateway_claim_v1($1,$2,$3,$4,$5) value",
      [
        owner,
        attempt,
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        bytes,
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ],
    );
  await expect(claim(B, 30)).rejects.toThrow("FORBIDDEN");
  await expect(claim(A, 100)).rejects.toThrow("INVALID_LENGTH");
  expect((await claim(A, 30))[0].value.kind).toBe("claimed");
  expect((await claim(A, 30))[0].value.kind).toBe("ambiguous");
  expect(
    (await db.query("select declared_bytes from app_private.gateway_requests"))
      .rows[0],
  ).toEqual({ declared_bytes: 30 });
  expect(
    (
      await db.query(
        "select reserved_bytes from public.user_usage where owner_id=$1",
        [A],
      )
    ).rows[0],
  ).toEqual({ reserved_bytes: 131172 });
});

it("denies all legacy write and accounting RPCs to every runtime role", async () => {
  const signatures = [
    "ss_begin_attempt_request(uuid,bigint,uuid,bigint)",
    "ss_finish_attempt_request(uuid,bigint)",
    "ss_record_observation(uuid,bigint,bigint)",
    "ss_finalize_verified(uuid,jsonb,bigint,text,text)",
    "ss_reconcile_removed_attempt(uuid,boolean,boolean)",
    "ss_settle_cleanup(uuid,boolean,boolean)",
  ];
  for (const role of [
    "anon",
    "authenticated",
    "service_role",
    "ss_gateway_executor",
    "ss_gateway_observer",
    "ss_gateway_finalizer",
    "ss_gateway_cleaner",
  ])
    for (const sig of signatures)
      expect(
        (
          await db.query<{ allowed: boolean }>(
            "select has_function_privilege($1,$2,'EXECUTE') allowed",
            [role, `public.${sig}`],
          )
        ).rows[0].allowed,
      ).toBe(false);
  const session = await reserve();
  const attempt = await allocate(session.id);
  await expect(
    call("service_role", A, "select public.ss_record_observation($1,1,30)", [
      attempt,
    ]),
  ).rejects.toThrow("permission denied");
  await expect(
    call("service_role", A, "select public.ss_settle_cleanup($1,true,true)", [
      session.id,
    ]),
  ).rejects.toThrow("permission denied");
});
