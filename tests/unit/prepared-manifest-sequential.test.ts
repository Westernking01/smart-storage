import { completeSyntheticFixtureStream } from "../database/prepared-stream-completion-fixture";
import { readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { seedPreparedManifest } from "../database/prepared-manifest-fixture";
import { PostgresPreparedManifestRegistration } from "../../src/lib/gateway/postgres-prepared-manifest.server";
import { PostgresPreparedBlockAuthority } from "../../src/lib/gateway/postgres-prepared-block.server";
import type { WriteIntent } from "../../src/lib/gateway/provider-contracts";

let db: PGlite;
type Fixture = Awaited<ReturnType<typeof seedPreparedManifest>>;
const pool = {
  connect: async () => ({
    query: async (sql: string, values?: unknown[]) =>
      sql.includes("AS allowed")
        ? { rows: [{ allowed: true }] }
        : db.query<Record<string, unknown>>(sql, values),
    release: () => {},
  }),
};
const registration = (f: Fixture) =>
  new PostgresPreparedManifestRegistration(pool, async () => ({
    ownerId: f.owner,
    executorId: f.executor,
  }));
const authority = (f: Fixture) =>
  new PostgresPreparedBlockAuthority(pool, async () => ({
    ownerId: f.owner,
    executorId: f.executor,
  }));
const scope = (
  f: Fixture,
  result: { manifestSha256: string },
  index: number,
) => ({
  ownerId: f.owner,
  checkpointId: f.checkpoint.id,
  manifestSha256: result.manifestSha256,
  blockIndex: index,
});
async function state(f: Fixture) {
  return (
    await db.query<Record<string, unknown>>(
      `select
    (select coalesce(jsonb_agg(to_jsonb(p) order by block_index),'[]') from app_private.prepared_block_plans p where owner_id=$1) plans,
    (select to_jsonb(u) from public.user_usage u where owner_id=$1) usage,
    (select to_jsonb(s) from public.upload_sessions s where id=$2) session,
    (select coalesce(jsonb_agg(to_jsonb(q) order by request_id),'[]') from app_private.gateway_requests q where owner_id=$1) requests,
    (select jsonb_agg(to_jsonb(a) order by id) from public.transfer_attempts a where owner_id=$1) attempts,
    (select coalesce(jsonb_agg(to_jsonb(r) order by resource_id),'[]') from app_private.gateway_resources r where owner_id=$1) resources,
    (select coalesce(jsonb_agg(to_jsonb(b) order by block_index),'[]') from app_private.prepared_block_bindings b where owner_id=$1) bindings`,
      [f.owner, f.session],
    )
  ).rows[0];
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema auth to anon,authenticated,service_role;`);
  for (const n of (await readdir("supabase/migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await db.exec(
      (await readFile("supabase/migrations/" + n, "utf8")).replace(
        /^\uFEFF/,
        "",
      ),
    );
}, 120000);
afterAll(async () => {
  await db?.close();
});

const completeFixtureStream = (f: Fixture, intent: WriteIntent) =>
  completeSyntheticFixtureStream(db, f, intent);

it("registers all three immutable plans atomically without claims, dispatch, or extra quota", async () => {
  const f = await seedPreparedManifest(db),
    before = await state(f);
  const result = await registration(f).register({
    checkpoint: f.checkpoint,
    reservation: f.reservation,
  });
  expect(result.blockCount).toBe(3);
  const after = await state(f);
  expect(after.plans).toHaveLength(3);
  expect({ ...after, plans: [] }).toEqual(before);
  for (let index = 0; index < 3; index++)
    await authority(f).resolve(scope(f, result, index));
  expect(await state(f)).toEqual(after); // Advisory lookup is also side-effect free.
});
it("claims/dispatches sequentially only after conclusive prior completion, retaining session quota", async () => {
  const f = await seedPreparedManifest(db, 3, false),
    before = await state(f);
  const result = await registration(f).register({
    checkpoint: f.checkpoint,
    reservation: f.reservation,
  });
  const registered = await state(f);
  expect(registered.requests).toEqual([]);
  expect(registered.resources).toEqual([]);
  for (let index = 0; index < 3; index++) {
    const resolution = await authority(f).resolve(scope(f, result, index));
    await authority(f).consumeDispatch(resolution.intent);
    expect(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from app_private.gateway_requests where session_id=$1 and slot_held",
          [f.session],
        )
      ).rows[0].n,
    ).toBe(1);
    const dispatched = await state(f);
    await expect(
      authority(f).consumeDispatch(resolution.intent),
    ).rejects.toThrow("SESSION_BLOCKED");
    expect(await state(f)).toEqual(dispatched);
    if (index < 2) {
      const next = await authority(f).resolve(scope(f, result, index + 1));
      await expect(authority(f).consumeDispatch(next.intent)).rejects.toThrow(
        /ATTEMPT_AMBIGUOUS|CAPACITY_EXCEEDED/,
      );
      expect(await state(f)).toEqual(dispatched); // Failed claim includes no attempted-byte increment.
      await db.query(
        "select public.ss_gateway_record_stream_outcome_v1($1,$2,$3,$4,'request_completed')",
        [f.owner, resolution.intent.requestId, f.executor, randomUUID()],
      );
      await expect(authority(f).consumeDispatch(next.intent)).rejects.toThrow(
        /ATTEMPT_AMBIGUOUS|CAPACITY_EXCEEDED/,
      );
      await completeFixtureStream(f, resolution.intent);
    }
  }
  const after = await state(f);
  expect(after.usage).toEqual(before.usage);
  expect(after.session).toEqual(registered.session);
  expect(after.plans).toHaveLength(3);
  expect(after.requests).toHaveLength(3);
  expect(after.bindings).toHaveLength(3);
  expect(
    (
      await db.query<{ total: number }>(
        "select sum(attempted_bytes)::int total from public.transfer_attempts where session_id=$1",
        [f.session],
      )
    ).rows[0].total,
  ).toBe(196608);
  expect(
    (
      await db.query<{ n: number }>(
        "select count(*)::int n from public.usage_events where session_id=$1",
        [f.session],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("atomically prepares missing descriptors from a real reservation; midway failure removes descriptors and state transition", async () => {
  const f = await seedPreparedManifest(db, 3, false),
    before = await state(f);
  const invalid = structuredClone(f.manifest);
  invalid.blocks[2].encodedSha256 = "invalid";
  const text = JSON.stringify(invalid),
    args = [...f.args];
  args[3] = createHash("sha256").update(text).digest("hex");
  args[4] = text;
  await db.exec("begin;set local role ss_gateway_executor");
  try {
    await expect(
      db.query(
        "select public.ss_prepared_manifest_register_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
        args,
      ),
    ).rejects.toThrow();
  } finally {
    await db.exec("rollback");
  }
  expect(await state(f)).toEqual(before);
  expect(
    (
      await db.query<{ n: number }>(
        "select count(*)::int n from public.file_blocks where session_id=$1",
        [f.session],
      )
    ).rows[0].n,
  ).toBe(0);
  await registration(f).register({
    checkpoint: f.checkpoint,
    reservation: f.reservation,
  });
  const after = await state(f);
  expect(after.plans).toHaveLength(3);
  expect(after.requests).toEqual([]);
  expect(after.resources).toEqual([]);
  expect(after.usage).toEqual(before.usage);
  expect(
    (
      await db.query<{ total: number }>(
        "select sum(attempted_bytes)::int total from public.transfer_attempts where session_id=$1",
        [f.session],
      )
    ).rows[0].total,
  ).toBe(0);
});
it("retains ambiguous-outcome occupancy and prevents the next block without partial effects", async () => {
  const f = await seedPreparedManifest(db);
  const result = await registration(f).register({
    checkpoint: f.checkpoint,
    reservation: f.reservation,
  });
  const first = await authority(f).resolve(scope(f, result, 0));
  await authority(f).consumeDispatch(first.intent);
  await db.query(
    "select public.ss_gateway_record_stream_outcome_v1($1,$2,$3,$4,'ambiguous')",
    [f.owner, first.intent.requestId, f.executor, randomUUID()],
  );
  const held = await state(f),
    next = await authority(f).resolve(scope(f, result, 1));
  await expect(authority(f).consumeDispatch(next.intent)).rejects.toThrow();
  expect(await state(f)).toEqual(held);
});
it("retains all committed plans on lost acknowledgment without retry or extra accounting", async () => {
  const f = await seedPreparedManifest(db),
    before = await state(f);
  const queries: string[] = [];
  const uncertain = new PostgresPreparedManifestRegistration(
    {
      connect: async () => {
        const c = await pool.connect();
        return {
          ...c,
          query: async (sql: string, values?: unknown[]) => {
            queries.push(sql);
            const result = await c.query(sql, values);
            if (sql === "COMMIT") throw Error("SIMULATED_LOST_ACK");
            return result;
          },
        };
      },
    },
    async () => ({ ownerId: f.owner, executorId: f.executor }),
  );
  await expect(
    uncertain.register({
      checkpoint: f.checkpoint,
      reservation: f.reservation,
    }),
  ).rejects.toThrow("SIMULATED_LOST_ACK");
  expect(
    queries.filter((sql) => sql.includes("ss_prepared_manifest_register_v1")),
  ).toHaveLength(1);
  const after = await state(f);
  expect(after.plans).toHaveLength(3);
  expect({ ...after, plans: [] }).toEqual(before);
  await expect(
    registration(f).register({
      checkpoint: f.checkpoint,
      reservation: f.reservation,
    }),
  ).rejects.toThrow();
  expect(await state(f)).toEqual(after);
});
it("rolls back an otherwise successful whole-manifest registration on caller abort", async () => {
  const f = await seedPreparedManifest(db),
    before = await state(f);
  await db.exec("begin;set local role ss_gateway_executor");
  try {
    await db.query(
      "select public.ss_prepared_manifest_register_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
      f.args,
    );
  } finally {
    await db.exec("rollback");
  }
  expect(await state(f)).toEqual(before);
});
it.each([1, 2])(
  "rolls back all registration state when block %i has an invalid durable attempt",
  async (index) => {
    const f = await seedPreparedManifest(db),
      before = await state(f),
      bad = structuredClone(f.reservation);
    bad.bindings[index].attemptId = randomUUID();
    await expect(
      registration(f).register({ checkpoint: f.checkpoint, reservation: bad }),
    ).rejects.toThrow();
    expect(await state(f)).toEqual(before);
    await registration(f).register({
      checkpoint: f.checkpoint,
      reservation: f.reservation,
    });
    expect((await state(f)).plans).toHaveLength(3);
  },
);
it("rejects duplicate/conflicting bindings and cannot overwrite existing plans", async () => {
  const f = await seedPreparedManifest(db);
  await registration(f).register({
    checkpoint: f.checkpoint,
    reservation: f.reservation,
  });
  const registered = await state(f);
  await expect(
    registration(f).register({
      checkpoint: f.checkpoint,
      reservation: f.reservation,
    }),
  ).rejects.toThrow();
  await expect(
    registration(f).register({
      checkpoint: { ...f.checkpoint, id: randomUUID() },
      reservation: f.reservation,
    }),
  ).rejects.toThrow();
  await expect(
    db.query(
      "update app_private.prepared_block_plans set checkpoint_id='overwrite' where owner_id=$1",
      [f.owner],
    ),
  ).rejects.toThrow("PREPARED_BINDING_IMMUTABLE");
  await expect(
    db.query("delete from app_private.prepared_block_plans where owner_id=$1", [
      f.owner,
    ]),
  ).rejects.toThrow("PREPARED_BINDING_IMMUTABLE");
  expect(await state(f)).toEqual(registered);
});
it("rolls back registration or dispatch on insufficient quota and changed expiry/owner/executor/intent", async () => {
  const f = await seedPreparedManifest(db);
  await db.query(
    "update public.user_usage set reserved_bytes=327679 where owner_id=$1",
    [f.owner],
  );
  const short = await state(f);
  await expect(
    registration(f).register({
      checkpoint: f.checkpoint,
      reservation: f.reservation,
    }),
  ).rejects.toThrow("QUOTA_INSUFFICIENT");
  expect(await state(f)).toEqual(short);
  await db.query(
    "update public.user_usage set reserved_bytes=327680 where owner_id=$1",
    [f.owner],
  );
  const result = await registration(f).register({
    checkpoint: f.checkpoint,
    reservation: f.reservation,
  });
  const r = await authority(f).resolve(scope(f, result, 0));
  await expect(
    authority(f).consumeDispatch({ ...r.intent, path: "forged" }),
  ).rejects.toThrow("IDENTITY_MISMATCH");
  await expect(
    authority(f).consumeDispatch({ ...r.intent, ownerId: randomUUID() }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    authority(f).consumeDispatch({ ...r.intent, executorId: randomUUID() }),
  ).rejects.toThrow("FORBIDDEN");
  await db.query(
    "update public.transfer_attempts set expires_at=clock_timestamp()-interval '1 second' where id=$1",
    [f.bindings[0].attemptId],
  );
  const expired = await state(f);
  await expect(authority(f).consumeDispatch(r.intent)).rejects.toThrow(
    "SESSION_BLOCKED",
  );
  expect(await state(f)).toEqual(expired);
});
it("rolls back request, resource, attempted-byte and binding creation if dispatch fails after claiming", async () => {
  const f = await seedPreparedManifest(db);
  const result = await registration(f).register({
    checkpoint: f.checkpoint,
    reservation: f.reservation,
  });
  const r = await authority(f).resolve(scope(f, result, 0));
  const before = await state(f);
  await db.exec(`begin;
    create function app_private.registration_test_fault() returns trigger language plpgsql as $$
      begin raise exception 'INJECTED_AFTER_CLAIM'; end $$;
    create trigger registration_test_fault before insert on app_private.prepared_block_bindings
      for each row execute function app_private.registration_test_fault();
    set local role ss_gateway_executor;`);
  try {
    await expect(
      db.query(
        "select public.ss_registered_block_dispatch_v1($1,$2,$3::jsonb)",
        [f.owner, f.executor, JSON.stringify(r.intent)],
      ),
    ).rejects.toThrow("INJECTED_AFTER_CLAIM");
  } finally {
    await db.exec("rollback");
  }
  expect(await state(f)).toEqual(before);
  await authority(f).consumeDispatch(r.intent);
});
it("keeps plans private, executor-only RPCs, immutable bindings and one-active-session index intact", async () => {
  for (const role of [
    "anon",
    "authenticated",
    "service_role",
    "ss_gateway_executor",
  ]) {
    await db.exec(`set role ${role}`);
    await expect(
      db.exec("select * from app_private.prepared_block_plans"),
    ).rejects.toThrow("permission denied");
    await db.exec("reset role");
  }
  const {
    rows: [security],
  } = await db.query(`select
    (select relrowsecurity from pg_class where oid='app_private.prepared_block_plans'::regclass) rls,
    (select indisunique and indpred is not null from pg_index where indexrelid='app_private.gateway_one_stream_per_session'::regclass) exclusion,
    has_function_privilege('authenticated','public.ss_registered_block_dispatch_v1(uuid,uuid,jsonb)','execute') ordinary,
    has_function_privilege('ss_gateway_executor','public.ss_registered_block_dispatch_v1(uuid,uuid,jsonb)','execute') executor`);
  expect(security).toEqual({
    rls: true,
    exclusion: true,
    ordinary: false,
    executor: true,
  });
});
