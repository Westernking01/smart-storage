import { createHash, randomUUID } from "node:crypto";

/** Synthetic unclaimed metadata only. No disabled triggers, requests or resources. */
export async function seedPreparedManifest(
  db: { query(sql: string, values?: unknown[]): Promise<unknown> },
  count = 3,
  withDescriptors = true,
) {
  const owner = randomUUID(),
    executor = randomUUID();
  let file: string = randomUUID();
  let session: string = randomUUID();
  const blocks = Array.from({ length: count }, (_, index) => ({
    index,
    offset: index * 65536,
    originalBytes: 65536,
    encodedBytes: 65536,
    codec: "raw" as const,
    originalSha256: "a".repeat(64),
    encodedSha256: "a".repeat(64),
  }));
  const manifest = {
    format: "compression-spike" as const,
    version: 1 as const,
    blockSize: 65536,
    originalBytes: count * 65536,
    originalSha256: "a".repeat(64),
    blocks,
  };
  const bindings = blocks.map(() => ({
    attemptId: randomUUID(),
    requestId: randomUUID(),
    resourceId: randomUUID(),
  }));
  await db.query("insert into auth.users values($1)", [owner]);
  await db.query("insert into public.profiles(id) values($1)", [owner]);
  await db.query(
    "insert into public.user_usage(owner_id,quota_bytes,reserved_bytes,active_slots,max_slots) values($1,1048576,$2,$3,1)",
    [owner, withDescriptors ? 327680 : 0, withDescriptors ? 1 : 0],
  );
  await db.query(
    "insert into app_private.gateway_accounts(owner_id,max_active_streams,bucket) values($1,2,'local-gateway-test')",
    [owner],
  );
  if (!withDescriptors) {
    // Real reservation/enrollment/accounting RPC under synthetic ordinary Auth.
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ sub: owner, role: "authenticated" }),
    ]);
    await db.query("set role authenticated");
    try {
      const result = (await db.query(
        "select public.ss_reserve($1,'test',null,$2,$3) reservation",
        [randomUUID(), manifest.originalBytes, manifest.originalSha256],
      )) as { rows: { reservation: { id: string; fileId: string } }[] };
      session = result.rows[0].reservation.id;
      file = result.rows[0].reservation.fileId;
    } finally {
      await db.query("reset role");
      await db.query("select set_config('request.jwt.claims','',false)");
    }
  } else {
    await db.query(
      "insert into public.files(id,owner_id,original_name,display_name,original_bytes,source_sha256) values($1,$2,'test','test',$3,$4)",
      [file, owner, manifest.originalBytes, manifest.originalSha256],
    );
    await db.query(
      `insert into public.upload_sessions(id,file_id,owner_id,idempotency_key,request_digest,state,held_bytes,lease_expires_at,initial_source_sha256,manifest_path)
    values($1,$2,$3,$4,'fixture','uploading',327680,clock_timestamp()+interval '1 day',$5,$6)`,
      [
        session,
        file,
        owner,
        randomUUID(),
        manifest.originalSha256,
        `fixture/${session}/manifest`,
      ],
    );
    for (const b of blocks) {
      const block = randomUUID(),
        attempt = bindings[b.index].attemptId;
      await db.query(
        `insert into public.file_blocks(id,file_id,session_id,owner_id,block_index,original_offset,original_bytes,encoded_bytes,codec,original_sha256,encoded_sha256)
      values($1,$2,$3,$4,$5,$6,65536,65536,'raw',$7,$7)`,
        [block, file, session, owner, b.index, b.offset, b.originalSha256],
      );
      await db.query(
        `insert into public.transfer_attempts(id,block_id,session_id,owner_id,epoch,object_path,authorized_max_bytes,expires_at)
      values($1,$2,$3,$4,1,$5,65536,clock_timestamp()+interval '1 day')`,
        [
          attempt,
          block,
          session,
          owner,
          `v1/${owner}/${file}/${session}/1/${b.index}/${attempt}.bin`,
        ],
      );
    }
  }
  const checkpoint = {
    version: 1,
    id: randomUUID(),
    revision: 0,
    ownerId: owner,
    originalBytes: manifest.originalBytes,
    sourceSha256: manifest.originalSha256,
    blockSize: 65536,
    phase: "prepared",
    blocks: blocks.map((block) => ({
      block,
      phase: "prepared",
      attemptedBytes: 0,
      acknowledgedBytes: 0,
      attemptId: null,
    })),
    manifest,
  };
  // Adapter uses canonical bytes; raw SQL qualification can use any digest-bound JSON serialization.
  const text = JSON.stringify(manifest);
  const reservationBindings: {
    attemptId?: string;
    requestId: string;
    resourceId: string;
  }[] = bindings.map((b) =>
    withDescriptors ? b : { requestId: b.requestId, resourceId: b.resourceId },
  );
  return {
    owner,
    executor,
    file,
    session,
    manifest,
    bindings,
    checkpoint,
    reservation: {
      sessionId: session,
      fileId: file,
      bindings: reservationBindings,
    },
    args: [
      owner,
      executor,
      checkpoint.id,
      createHash("sha256").update(text).digest("hex"),
      text,
      session,
      file,
      JSON.stringify(reservationBindings),
    ] as unknown[],
  };
}
