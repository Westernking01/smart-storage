import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  h = "a".repeat(64);
// Optional local runtime is loaded dynamically so missing infrastructure does not
// break application compilation. This suite FAILS explicitly if it is unavailable.
interface Queryable {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(
    sql: string,
    args?: unknown[],
  ): Promise<{ rows: T[] }>;
}
interface Database extends Queryable {
  transaction<T>(run: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
let db: Database;
async function actor(
  id: string,
  sql: string,
  args: unknown[] = [],
  role = "authenticated",
  anonymous = false,
) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: id, role, is_anonymous: anonymous }),
    ]);
    return (await tx.query(sql, args)).rows;
  });
}
const service = (sql: string, args: unknown[] = []) =>
  actor(A, sql, args, "service_role");
async function reserve(id = A, key = "request_key_00001", bytes = 100) {
  const rows = await actor(
    id,
    "select public.ss_reserve($1,'sample.bin','application/octet-stream',$2,$3) value",
    [key, bytes, h],
  );
  return rows[0].value as {
    id: string;
    fileId: string;
    epoch: number;
    heldBytes: string;
  };
}
async function ready(id = A, key = "request_key_00001", publish = true) {
  const s = await reserve(id, key);
  const rows = await actor(
    id,
    "select public.ss_allocate_attempt($1,0,100,100,'raw',$2,$2) value",
    [s.id, h],
  );
  const a = rows[0].value as { id: string };
  await service("select public.ss_record_observation($1,1,100)", [a.id]);
  const manifest = {
    format: "compression-spike",
    version: 1,
    blockSize: 8388608,
    originalBytes: 100,
    originalSha256: h,
    blocks: [
      {
        index: 0,
        offset: 0,
        originalBytes: 100,
        encodedBytes: 100,
        codec: "raw",
        originalSha256: h,
        encodedSha256: h,
      },
    ],
  };
  const [{ manifest_path: path }] = await db
    .query<{ manifest_path: string }>(
      "select manifest_path from public.upload_sessions where id=$1",
      [s.id],
    )
    .then((r) => r.rows);
  if (publish)
    await service(
      "select public.ss_finalize_verified($1,$2::jsonb,500,$3,$4)",
      [s.id, JSON.stringify(manifest), h, path],
    );
  return { s, a, manifest, path };
}
beforeAll(async () => {
  const moduleName = "@electric-sql/pglite";
  const runtime = (await import(moduleName)) as {
    PGlite: { create: () => Promise<Database> };
  };
  if (typeof runtime.PGlite?.create !== "function")
    throw Error("DATABASE_RUNTIME_UNAVAILABLE");
  db = await runtime.PGlite.create();
  // Test-only Supabase Auth schema/role shims. This is actual PostgreSQL SQL/RLS,
  // not a Supabase Auth server, Storage service or multi-connection race test.
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema auth to anon,authenticated,service_role;
    insert into auth.users values('${A}'),('${B}');`);
  for (const name of [
    "202610130001_backend_schema.sql",
    "202610130002_control_functions.sql",
    "202610130003_trusted_transitions_and_rls.sql",
  ])
    await db.exec(readFileSync(resolve("supabase/migrations", name), "utf8"));
  // Deliberately synthetic Storage implementation: exercise exact policy predicates,
  // not the guard, provider operation semantics, HTTP errors or Storage-managed grants.
  await db.exec(`create schema storage;
    create table storage.objects(bucket_id text not null,name text not null,primary key(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated;
    grant select,insert,update,delete on storage.objects to anon,authenticated;
    create function storage.allow_any_operation(text[]) returns boolean language sql stable as $$ select current_setting('test.storage_operation',true)=any($1) $$;
    create policy fixture_broad_access on storage.objects for all to public using(true) with check(true);`);
  const policies = readFileSync(
    resolve("supabase/storage/policies.review.sql"),
    "utf8",
  );
  await db.exec(
    policies.slice(
      policies.indexOf("create policy"),
      policies.lastIndexOf("rollback;"),
    ),
  );
});
beforeEach(async () => {
  await db.exec(
    "truncate public.profiles cascade; truncate storage.objects; update app_private.account_policy set quota_bytes=1048576,max_slots=2; select set_config('test.storage_operation','object.get_authenticated',false);",
  );
  await actor(A, "select public.ss_bootstrap()");
  await actor(B, "select public.ss_bootstrap()");
});
afterAll(async () => {
  await db?.close();
});
describe("actual disposable embedded PostgreSQL foundation", () => {
  it("rejects string-encoded numeric manifest fields without publishing or releasing accounting", async () => {
    const { s, manifest, path } = await ready(
      A,
      "numeric_manifest_test",
      false,
    );
    for (const field of ["version", "blockSize", "originalBytes"] as const) {
      await expect(
        service("select public.ss_finalize_verified($1,$2::jsonb,500,$3,$4)", [
          s.id,
          JSON.stringify({ ...manifest, [field]: String(manifest[field]) }),
          h,
          path,
        ]),
      ).rejects.toThrow("MANIFEST_INVALID");
    }
    expect(
      (await actor(A, "select public.ss_list_files() value"))[0].value,
    ).toEqual([]);
    expect(
      (await actor(A, "select public.ss_account() value"))[0].value,
    ).toMatchObject({ usage: { reservedBytes: "131172", activeSlots: 1 } });
  });
  it("constrains broad Storage policies to ready owner paths and allowed operations (helper shim only)", async () => {
    const { s, path } = await ready();
    const attempt = (
      await db.query<{ object_path: string }>(
        "select object_path from public.transfer_attempts where session_id=$1",
        [s.id],
      )
    ).rows[0].object_path;
    await db.query(
      "insert into storage.objects values('smart-storage-private-v1',$1),('smart-storage-private-v1',$2),('smart-storage-private-v1','unallocated'),('unrelated','retained')",
      [path, attempt],
    );
    expect(
      (
        await actor(
          A,
          "select name from storage.objects where bucket_id='smart-storage-private-v1' order by name",
        )
      )
        .map((r) => r.name)
        .sort(),
    ).toEqual([path, attempt].sort());
    expect(
      await actor(
        B,
        "select name from storage.objects where bucket_id='smart-storage-private-v1'",
      ),
    ).toEqual([]);
    // The anonymous branch may fail on referenced app-table privileges rather than filter.
    await expect(
      actor(
        A,
        "select name from storage.objects where bucket_id='smart-storage-private-v1'",
        [],
        "anon",
      ),
    ).rejects.toThrow("permission denied");
    await db.exec(
      "select set_config('test.storage_operation','object.list',false)",
    );
    expect(
      await actor(
        A,
        "select name from storage.objects where bucket_id='smart-storage-private-v1'",
      ),
    ).toEqual([]);
    await db.exec(
      "select set_config('test.storage_operation','object.get_authenticated_info',false)",
    );
    expect(
      await actor(
        A,
        "select name from storage.objects where bucket_id='smart-storage-private-v1'",
      ),
    ).toHaveLength(2);
    await actor(A, "select public.ss_delete_file($1)", [s.fileId]);
    expect(
      await actor(
        A,
        "select name from storage.objects where bucket_id='smart-storage-private-v1'",
      ),
    ).toEqual([]);
  });
  it("denies ordinary private Storage writes even with permissive access and preserves other buckets", async () => {
    await db.exec(
      "insert into storage.objects values('smart-storage-private-v1','existing'),('unrelated','retained')",
    );
    await expect(
      actor(
        A,
        "insert into storage.objects values('smart-storage-private-v1','new')",
      ),
    ).rejects.toThrow("row-level security");
    expect(
      await actor(
        A,
        "update storage.objects set name='overwritten' where bucket_id='smart-storage-private-v1' returning name",
      ),
    ).toEqual([]);
    expect(
      await actor(
        A,
        "delete from storage.objects where bucket_id='smart-storage-private-v1' returning name",
      ),
    ).toEqual([]);
    await actor(A, "insert into storage.objects values('unrelated','new')");
    expect(
      await actor(
        A,
        "delete from storage.objects where bucket_id='unrelated' returning name",
      ),
    ).toHaveLength(2);
    expect(
      (await db.query("select count(*)::int count from storage.objects"))
        .rows[0].count,
    ).toBe(1);
  });
  it("uses empty definer search paths and exact ordinary-versus-worker execution privileges", async () => {
    const funcs = await db.query<{
      proname: string;
      proconfig: string[];
      auth: boolean;
      anon: boolean;
      worker: boolean;
    }>(
      "select proname,proconfig,has_function_privilege('authenticated',oid,'EXECUTE') auth,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('service_role',oid,'EXECUTE') worker from pg_proc where pronamespace='public'::regnamespace and proname like 'ss_%'",
    );
    expect(funcs.rows).toHaveLength(17);
    for (const f of funcs.rows) {
      expect(f.proconfig).toContain('search_path=""');
      expect(f.anon).toBe(false);
      const trusted = [
        "ss_begin_attempt_request",
        "ss_finish_attempt_request",
        "ss_record_observation",
        "ss_finalize_verified",
        "ss_expire",
        "ss_reconcile_removed_attempt",
        "ss_settle_cleanup",
      ].includes(f.proname);
      expect(f.auth).toBe(!trusted);
      if (trusted) expect(f.worker).toBe(true);
    }
  });
  it("isolates owned ready files, manifests, blocks, sessions and quota via RLS", async () => {
    const a = await ready(),
      b = await ready(B, "request_key_00002");
    const files = await actor(A, "select public.ss_list_files() value");
    expect((files[0].value as { id: string }[]).map((f) => f.id)).toEqual([
      a.s.fileId,
    ]);
    for (const table of [
      "files",
      "file_manifests",
      "file_blocks",
      "upload_sessions",
      "transfer_attempts",
      "user_usage",
      "usage_events",
    ]) {
      expect(
        await actor(A, `select 1 from public.${table} where owner_id=$1`, [B]),
      ).toEqual([]);
    }
    await expect(
      actor(A, "select public.ss_file($1)", [b.s.fileId]),
    ).rejects.toThrow("NOT_FOUND");
  });
  it("denies cross-user mutation, direct writes, anonymous access and privileged proof forgery", async () => {
    const b = await ready(B);
    await expect(
      actor(A, "select public.ss_edit_file($1,'changed.bin','other',0)", [
        b.s.fileId,
      ]),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      actor(A, "select public.ss_delete_file($1)", [b.s.fileId]),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      actor(A, "update public.files set owner_id=$1", [B]),
    ).rejects.toThrow();
    await expect(
      actor(A, "insert into public.profiles(id) values(gen_random_uuid())"),
    ).rejects.toThrow();
    await expect(
      actor(A, "update public.user_usage set quota_bytes=9223372036854775807"),
    ).rejects.toThrow();
    await expect(
      actor(A, "select * from public.files", [], "anon"),
    ).rejects.toThrow();
    await expect(
      actor(A, "select public.ss_account()", [], "authenticated", true),
    ).rejects.toThrow("UNAUTHENTICATED");
    await expect(
      actor(A, "select public.ss_record_observation(gen_random_uuid(),1,100)"),
    ).rejects.toThrow("permission denied");
    await expect(
      actor(A, "select public.ss_settle_cleanup(gen_random_uuid(),true,true)"),
    ).rejects.toThrow("permission denied");
  });
  it("reserves queued competing requests atomically within slots and quota (single connection)", async () => {
    const results = await Promise.allSettled(
      [1, 2, 3].map((i) => reserve(A, `queued_request_key_${i}`)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(
      String(
        (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
          .reason,
      ),
    ).toContain("SLOTS_EXCEEDED");
    const [{ reserved_bytes, active_slots }] = await db
      .query<{ reserved_bytes: number; active_slots: number }>(
        "select reserved_bytes,active_slots from public.user_usage where owner_id=$1",
        [A],
      )
      .then((r) => r.rows);
    expect(Number(reserved_bytes)).toBe(2 * (131072 + 100));
    expect(active_slots).toBe(2);
    await db.query(
      "update public.user_usage set max_slots=2,quota_bytes=reserved_bytes where owner_id=$1",
      [A],
    );
    await expect(reserve(A, "different_request_key")).rejects.toThrow(
      "QUOTA_EXCEEDED",
    );
  });
  it("binds idempotency to immutable request input and rejects invalid/overflow byte counts", async () => {
    const one = await reserve();
    expect(await reserve()).toEqual(one);
    await expect(reserve(A, "request_key_00001", 101)).rejects.toThrow(
      "IDEMPOTENCY_CONFLICT",
    );
    for (const bytes of [-1, "9223372036854775807", "9223372036854775808"]) {
      await expect(
        actor(
          A,
          "select public.ss_reserve('overflow_key_0001','x.bin',null,$1,$2)",
          [bytes, h],
        ),
      ).rejects.toThrow();
    }
    expect(
      (
        await db.query(
          "select count(*)::int count from public.usage_events where kind='reserve'",
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it("requires exact fenced attempts and retains ambiguous request accounting", async () => {
    const s = await reserve();
    const rows = await actor(
      A,
      "select public.ss_allocate_attempt($1,0,100,100,'raw',$2,$2) value",
      [s.id, h],
    );
    const a = rows[0].value as {
      id: string;
      path: string;
      storageAuthorityEnabled: boolean;
    };
    expect(a.path).toContain(`v1/${A}/${s.fileId}/${s.id}/1/0/`);
    expect(a.storageAuthorityEnabled).toBe(false);
    const request = crypto.randomUUID();
    await service("select public.ss_begin_attempt_request($1,1,$2,100)", [
      a.id,
      request,
    ]);
    await service("select public.ss_finish_attempt_request($1,null)", [
      request,
    ]);
    await expect(
      service("select public.ss_begin_attempt_request($1,1,$2,100)", [
        a.id,
        request,
      ]),
    ).rejects.toThrow("REQUEST_REPLAY");
    await expect(
      actor(A, "select public.ss_allocate_attempt($1,0,100,100,'raw',$2,$2)", [
        s.id,
        h,
      ]),
    ).rejects.toThrow("AMBIGUOUS_ATTEMPT_LOCKED");
    await expect(
      service("select public.ss_reconcile_removed_attempt($1,false,true)", [
        a.id,
      ]),
    ).rejects.toThrow("CLEANUP_PROOF_REQUIRED");
    await service("select public.ss_reconcile_removed_attempt($1,true,true)", [
      a.id,
    ]);
    const second = (
      await actor(
        A,
        "select public.ss_allocate_attempt($1,0,100,100,'raw',$2,$2) value",
        [s.id, h],
      )
    )[0].value as { id: string; epoch: number };
    expect(second.id).not.toBe(a.id);
    expect(second.epoch).toBe(2);
    const history = await db.query<{ attempted_bytes: number; state: string }>(
      "select attempted_bytes,state from public.transfer_attempts where id=$1",
      [a.id],
    );
    expect(Number(history.rows[0].attempted_bytes)).toBe(100);
    expect(history.rows[0].state).toBe("settled");
  });
  it("commits verified metadata once, preserves historical usage on soft delete, releases once after proof", async () => {
    const { s, manifest, path } = await ready();
    await service(
      "select public.ss_finalize_verified($1,$2::jsonb,500,$3,$4)",
      [s.id, JSON.stringify(manifest), h, path],
    );
    expect(
      (
        await db.query(
          "select count(*)::int count from public.usage_events where kind='commit'",
        )
      ).rows[0].count,
    ).toBe(1);
    await actor(A, "select public.ss_edit_file($1,'renamed.bin','archive',1)", [
      s.fileId,
    ]);
    await expect(
      actor(A, "select public.ss_edit_file($1,'stale.bin','other',1)", [
        s.fileId,
      ]),
    ).rejects.toThrow("REVISION_CONFLICT");
    await actor(A, "select public.ss_delete_file($1)", [s.fileId]);
    expect(
      (await actor(A, "select public.ss_list_files() value"))[0].value,
    ).toEqual([]);
    expect(
      Number(
        (
          await db.query(
            "select stored_bytes from public.user_usage where owner_id=$1",
            [A],
          )
        ).rows[0].stored_bytes,
      ),
    ).toBe(600);
    await expect(
      service("select public.ss_settle_cleanup($1,false,true)", [s.id]),
    ).rejects.toThrow("CLEANUP_PROOF_REQUIRED");
    await service("select public.ss_settle_cleanup($1,true,true)", [s.id]);
    await service("select public.ss_settle_cleanup($1,true,true)", [s.id]);
    const usage = (await actor(A, "select public.ss_account() value"))[0]
      .value as {
      usage: { storedBytes: string; historicalStoredBytes: string };
    };
    expect(usage.usage.storedBytes).toBe("0");
    expect(usage.usage.historicalStoredBytes).toBe("600");
    expect(
      (
        await db.query(
          "select count(*)::int count from public.usage_events where kind='delete'",
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it("expires and fences without refund, rejects stale work and premature finalize", async () => {
    const s = await reserve();
    await db.query(
      "update public.upload_sessions set lease_expires_at=now()-interval '1 second' where id=$1",
      [s.id],
    );
    await service("select public.ss_expire($1)", [s.id]);
    const usage = (await actor(A, "select public.ss_account() value"))[0]
      .value as { usage: { reservedBytes: string; activeSlots: number } };
    expect(usage.usage.reservedBytes).toBe("131172");
    expect(usage.usage.activeSlots).toBe(1);
    await expect(
      actor(A, "select public.ss_allocate_attempt($1,0,100,100,'raw',$2,$2)", [
        s.id,
        h,
      ]),
    ).rejects.toThrow("SESSION_EXPIRED_OR_BLOCKED");
    await expect(
      service(
        "select public.ss_finalize_verified($1,'{}'::jsonb,100,$2,'forged')",
        [s.id, h],
      ),
    ).rejects.toThrow("SESSION_EXPIRED_OR_BLOCKED");
    await service("select public.ss_settle_cleanup($1,true,true)", [s.id]);
    expect(
      (
        (await actor(A, "select public.ss_account() value"))[0].value as {
          usage: { reservedBytes: string };
        }
      ).usage.reservedBytes,
    ).toBe("0");
  });
  it("rejects foreign composite owner references and invalid manifest evidence before publication", async () => {
    const s = await reserve();
    await expect(
      db.query(
        "insert into public.file_blocks(file_id,session_id,owner_id,block_index,original_offset,original_bytes,encoded_bytes,codec,original_sha256,encoded_sha256) values($1,$2,$3,0,0,100,100,'raw',$4,$4)",
        [s.fileId, s.id, B, h],
      ),
    ).rejects.toThrow();
    await expect(
      service(
        "select public.ss_finalize_verified($1,'{}'::jsonb,100,$2,'foreign')",
        [s.id, h],
      ),
    ).rejects.toThrow();
    expect(
      (await actor(A, "select public.ss_list_files() value"))[0].value,
    ).toEqual([]);
    const r = await db.query(
      "select relname,relrowsecurity from pg_class where oid in ('public.files'::regclass,'public.file_manifests'::regclass,'public.user_usage'::regclass)",
    );
    expect(r.rows.every((row) => row.relrowsecurity)).toBe(true);
  });
});
