import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, it, expect } from "vitest";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  F = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT null::uuid$$;`,
  );
  // Cast the authenticated subject exactly as the hosted auth.uid() contract does.
  await db.exec(
    `CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$; CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claims',true),'')::jsonb$$; GRANT USAGE ON SCHEMA auth TO authenticated;`,
  );
  for (const name of [
    "202610130001_backend_schema.sql",
    "202610130002_control_functions.sql",
    "202610130003_trusted_transitions_and_rls.sql",
  ])
    await db.exec(readFileSync("supabase/migrations/" + name, "utf8"));
  await db.exec(
    readFileSync("supabase/review/persistent-file-explorer.sql", "utf8"),
  );
  await db.query("INSERT INTO auth.users VALUES($1),($2)", [A, B]);
  await db.query("INSERT INTO public.profiles(id) VALUES($1),($2)", [A, B]);
  await db.query(
    `INSERT INTO public.files(id,owner_id,original_name,display_name,original_mime,original_bytes,source_sha256,state,encoded_payload_bytes,manifest_bytes,stored_bytes,manifest_sha256,manifest_path,block_count,ready_at) VALUES($1,$2,'fixture.txt','fixture.txt','text/plain',128,repeat('a',64),'ready',80,20,100,repeat('b',64),'fixture-manifest',1,now())`,
    [F, A],
  );
}, 60000);
afterAll(async () => {
  await db?.close();
});
async function as(owner: string) {
  await db.exec("RESET ROLE");
  await db.query("SELECT set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: owner, role: "authenticated", is_anonymous: false }),
  ]);
  await db.exec("SET ROLE authenticated");
}
async function call(sql: string, args: unknown[] = []) {
  return (
    await db.query<{ v: Record<string, unknown> }>(`SELECT ${sql} AS v`, args)
  ).rows[0].v;
}
it("creates nested folders, persists locations across transactions/sign-in and preserves payload accounting", async () => {
  await as(A);
  await call("public.ss_folder_create($1,null,$2)", [D, "Work"]);
  await call("public.ss_folder_create($1,$2,$3)", [E, D, "Notes"]);
  await call("public.ss_file_move($1,$2,0)", [F, E]);
  await as(B);
  expect(
    (await call("public.ss_explorer_list(null,'','name',0)")).folders,
  ).toEqual([]);
  await expect(call("public.ss_file_move($1,null,1)", [F])).rejects.toThrow(
    "NOT_FOUND",
  );
  await expect(
    call("public.ss_folder_rename($1,$2,0)", [D, "Other"]),
  ).rejects.toThrow("NOT_FOUND");
  await as(A);
  const list = await call("public.ss_explorer_list($1,'','name',0)", [E]);
  expect((list.breadcrumbs as { name: string }[]).map((v) => v.name)).toEqual([
    "Work",
    "Notes",
  ]);
  expect(
    (list.files as { file: { id: string; storedBytes: string } }[])[0].file,
  ).toMatchObject({ id: F, storedBytes: "100" });
  await expect(call("public.ss_file_move($1,null,0)", [F])).rejects.toThrow(
    "REVISION_CONFLICT",
  );
  await expect(
    db.query(
      "INSERT INTO public.file_folders(id,owner_id,name) VALUES($1,$2,$3)",
      [crypto.randomUUID(), B, "Bad"],
    ),
  ).rejects.toThrow(/permission denied/);
  await expect(db.query("SELECT * FROM public.file_locations")).rejects.toThrow(
    /permission denied/,
  );
  await db.exec("RESET ROLE");
  const data = await db.query<{ folder_id: string }>(
    "SELECT folder_id FROM public.file_locations WHERE file_id=$1",
    [F],
  );
  expect(data.rows[0].folder_id).toBe(E);
});
it("renames folder and file with revision fencing, searches and moves without changing cloud integrity", async () => {
  await as(A);
  await call("public.ss_folder_rename($1,$2,0)", [D, "Documents"]);
  await call("public.ss_edit_file($1,$2,$3,0)", [F, "renamed.txt", "document"]);
  const result = await call("public.ss_explorer_list(null,'renamed','type',0)");
  expect(
    (
      result.files as {
        file: {
          displayName: string;
          originalName: string;
          storedBytes: string;
        };
      }[]
    )[0].file,
  ).toMatchObject({
    displayName: "renamed.txt",
    originalName: "fixture.txt",
    storedBytes: "100",
  });
  await call("public.ss_file_move($1,null,1)", [F]);
  expect(
    (await call("public.ss_explorer_list(null,'','size',0)")).files,
  ).toHaveLength(1);
  await as(B);
  await expect(
    call("public.ss_folder_create($1,$2,$3)", [
      crypto.randomUUID(),
      D,
      "Cross owner",
    ]),
  ).rejects.toThrow("NOT_FOUND");
  await as(A);
  await expect(
    call("public.ss_folder_create($1,null,$2)", [
      crypto.randomUUID(),
      "../bad",
    ]),
  ).rejects.toThrow("INVALID_INPUT");
});

it("paginates searched owner files without losing metadata when sorting", async () => {
  await db.exec("RESET ROLE");
  await db.query(
    `INSERT INTO public.files(id,owner_id,original_name,display_name,original_mime,original_bytes,source_sha256,state,encoded_payload_bytes,manifest_bytes,stored_bytes,manifest_sha256,manifest_path,block_count,ready_at)
 SELECT gen_random_uuid(),$1,'paged-'||n||'.txt','paged-'||n||'.txt','text/plain',128+n,repeat('a',64),'ready',80,20,100,repeat('b',64),'paged-manifest-'||n,1,now() FROM generate_series(1,27) AS n`,
    [A],
  );
  await as(A);
  const first = await call("public.ss_explorer_list(null,'paged-','size',0)");
  const second = await call("public.ss_explorer_list(null,'paged-','size',25)");
  expect(first.files).toHaveLength(25);
  expect(first.next).toBe(25);
  expect(second.files).toHaveLength(2);
  expect(second.next).toBeNull();
  const ids = [
    ...(first.files as { file: { id: string } }[]),
    ...(second.files as { file: { id: string } }[]),
  ].map((v) => v.file.id);
  expect(new Set(ids).size).toBe(27);
  await as(B);
  expect(
    (await call("public.ss_explorer_list(null,'paged-','size',0)")).files,
  ).toEqual([]);
});
