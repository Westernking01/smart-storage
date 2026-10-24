import { randomUUID } from "node:crypto";
import type { WriteIntent } from "../../src/lib/gateway/provider-contracts";
// Privileged SYNTHETIC evidence imports, confined to fresh disposable test databases. This
// exercises existing completion guards, never asserts actual provider evidence.
export async function completeSyntheticFixtureStream(
  db: { query(sql: string, values?: unknown[]): Promise<unknown> },
  f: { owner: string; session: string },
  intent: WriteIntent,
) {
  const resource = randomUUID(),
    protocol = randomUUID(),
    terminal = randomUUID(),
    present = randomUUID();
  await db.query(
    "select public.ss_gateway_register_resource_v1($1,$2,$3,1,'object',$4,$5::jsonb,65536)",
    [
      f.owner,
      intent.requestId,
      resource,
      intent.path,
      JSON.stringify({
        namespace: "SQL FIXTURE ONLY",
        uploadId: null,
        version: "synthetic-v1",
        generation: null,
      }),
    ],
  );
  await db.query(
    "insert into app_private.gateway_protocols values($1,'SQL FIXTURE ONLY',$2,'SYNTHETIC ONLY',repeat('b',64))",
    [protocol, randomUUID()],
  );
  const observation = (await db.query(
    `select public.ss_gateway_record_receipt_v1($1,$2,$3,1,
    jsonb_build_object('scope',r.scope,'kind','inspection','outcome','present','observedBytes',65536,
    'observedAt',clock_timestamp(),'provenance',jsonb_build_object('fixture','SQL ONLY'),'verifierRevision','SQL ONLY')) id
    from app_private.gateway_resources r where resource_id=$2`,
    [f.owner, resource, randomUUID()],
  )) as { rows: { id: string }[] };
  const observationId = observation.rows[0].id;
  for (const kind of ["terminal", "present"])
    await db.query(
      `insert into app_private.gateway_verifications(
    verification_id,protocol_id,owner_id,session_id,decision_epoch,membership_digest,kind,resource_id,
    observation_id,terminal_id,writer_digest,content_sha256,accepted_bytes,acknowledged_bytes,
    evidence_reference,evidence_sha256,barrier_reference) values($1,$2,$3,$4,1,app_private.gateway_membership_digest($4),$5,$6,
    $7,$8,app_private.gateway_writer_digest($4),repeat('a',64),65536,65536,'SYNTHETIC ONLY',repeat('b',64),'NOT PROVIDER CAUSALITY')`,
      [
        kind === "terminal" ? terminal : present,
        protocol,
        f.owner,
        f.session,
        kind,
        resource,
        kind === "terminal" ? null : observationId,
        kind === "terminal" ? null : terminal,
      ],
    );
  await db.query("begin");
  await db.query("set local role ss_gateway_executor");
  try {
    await db.query(
      "select public.ss_gateway_complete_stream_v1($1,$2,1,$3,$4,$5,$6)",
      [f.owner, intent.requestId, randomUUID(), resource, present, terminal],
    );
    await db.query("commit");
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
}
