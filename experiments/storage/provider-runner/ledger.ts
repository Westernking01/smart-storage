import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  BUCKET,
  RUN,
  MANIFEST_HASH,
  MAX_ALLOCATIONS,
  MAX_BYTES,
  PATHS,
  USERS,
  hash,
  validateIntent,
  slot,
  STAGES,
  type Actor,
  type Intent,
} from "./manifest.js";
import {
  isCrossReadDenial,
  type KnownObject,
  type ProviderError,
} from "./denial.js";
import {
  renewalBytes,
  validateRenewalEvidence,
  type RenewalEvent,
} from "./renewal-evidence.js";

export interface DenialReconciliation {
  classification: "EXPECTED_PROVIDER_DENIAL";
  ordinaryRole: true;
  appVersion: "1.80.2";
  providerEventAt: string;
  stage: "cross-read-B";
  source: "VALIDATED_EXISTING_PROVIDER_LOG";
  evidenceDigest: string;
  recordedAt: string;
  originalState: "failed";
  originalHalt: "DENIAL_NOT_ESTABLISHED";
  originalStatus: 400;
  allocations: 1;
  bytes: 474;
  actor: "B";
  method: "GET";
  object: KnownObject;
  error: ProviderError;
}

export interface Codec {
  encode(plain: string): string;
  decode(cipher: string): string;
}
export interface Entry {
  sequence: number;
  id: string;
  actor: Actor;
  bucket: string;
  path?: string;
  allocation: boolean;
  allocationAttempt: number;
  method: string;
  purpose: string;
  bodyBytes: number;
  cumulativeBytes: number;
  status?: number;
  state: "reserved" | "completed" | "failed" | "ambiguous";
  resourceRef?: string;
  owner?: string;
  ownerSource?: string;
  offset?: number;
  cleanup: "not-eligible" | "eligible" | "deleted" | "uncertain";
  providerError?: ProviderError;
}
export interface State {
  renewalEvents?: RenewalEvent[];
  version: 1;
  run: string;
  bucket: string;
  manifestHash: string;
  generation: number;
  allocations: number;
  bytes: number;
  entries: Entry[];
  reconciliations?: DenialReconciliation[];
  halted?: string;
  sessions: Partial<Record<"A" | "B", { token: string; verified: boolean }>>;
  resources: Record<
    string,
    {
      url: string;
      path: string;
      actor: Actor;
      offset: number;
      complete: boolean;
    }
  >;
}
interface Envelope {
  generation: number;
  previous: string;
  cipher: string;
  digest: string;
}
export function outsideRepository(directory: string, repository: string): void {
  const rel = relative(resolve(repository), resolve(directory));
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)))
    throw new Error("PRIVATE_STORE_MUST_BE_OUTSIDE_REPOSITORY");
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink())
    throw new Error("PRIVATE_STORE_LINK_REJECTED");
}
function durable(path: string, value: string, flag: "wx" | "a"): void {
  const fd = openSync(path, flag, 0o600);
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function integrity(state: State): void {
  validateRenewalEvidence(state);
  if (
    state.version !== 1 ||
    state.run !== RUN ||
    state.bucket !== BUCKET ||
    state.manifestHash !== MANIFEST_HASH ||
    !Number.isSafeInteger(state.generation) ||
    state.generation < 0 ||
    !Array.isArray(state.entries) ||
    !state.sessions ||
    !state.resources
  )
    throw new Error("LEDGER_INTEGRITY");
  let bytes = 0,
    allocations = 0;
  const ids = new Set<string>();
  for (const [i, e] of state.entries.entries()) {
    if (
      e.sequence !== i + 1 ||
      ids.has(e.id) ||
      e.bucket !== BUCKET ||
      (e.path && !PATHS.some((p) => p.path === e.path)) ||
      !["A", "B", "anonymous"].includes(e.actor) ||
      !["reserved", "completed", "failed", "ambiguous"].includes(e.state) ||
      !Number.isSafeInteger(e.bodyBytes) ||
      e.bodyBytes < 0
    )
      throw new Error("LEDGER_INTEGRITY");
    ids.add(e.id);
    bytes += e.bodyBytes;
    if (e.allocation) allocations++;
    if (bytes !== e.cumulativeBytes || allocations !== e.allocationAttempt)
      throw new Error("LEDGER_COUNTER_INTEGRITY");
  }
  if (
    bytes !== state.bytes ||
    allocations !== state.allocations ||
    bytes > MAX_BYTES ||
    allocations > MAX_ALLOCATIONS
  )
    throw new Error("LEDGER_COUNTER_INTEGRITY");
  if (
    state.reconciliations !== undefined &&
    (!Array.isArray(state.reconciliations) ||
      state.reconciliations.length > 1 ||
      state.reconciliations.some((r) => !validReconciliation(state, r)))
  )
    throw new Error("LEDGER_RECONCILIATION_INTEGRITY");
}
function validReconciliation(state: State, r: DenialReconciliation): boolean {
  const e = state.entries[6];
  return (
    r.classification === "EXPECTED_PROVIDER_DENIAL" &&
    r.ordinaryRole === true &&
    r.appVersion === "1.80.2" &&
    Number.isFinite(Date.parse(r.providerEventAt)) &&
    r.stage === "cross-read-B" &&
    r.source === "VALIDATED_EXISTING_PROVIDER_LOG" &&
    /^[a-f0-9]{64}$/.test(r.evidenceDigest) &&
    Number.isFinite(Date.parse(r.recordedAt)) &&
    r.originalState === "failed" &&
    r.originalHalt === "DENIAL_NOT_ESTABLISHED" &&
    r.originalStatus === 400 &&
    r.allocations === 1 &&
    r.bytes === 474 &&
    r.actor === "B" &&
    r.method === "GET" &&
    !!e &&
    e.id === "cross-read-B" &&
    e.actor === "B" &&
    e.method === "GET" &&
    e.purpose === "cross-read" &&
    e.path === slot(0) &&
    e.status === 400 &&
    e.state === "failed" &&
    !e.allocation &&
    e.bodyBytes === 0 &&
    e.cumulativeBytes === 474 &&
    e.allocationAttempt === 1 &&
    state.entries
      .slice(0, 6)
      .every(
        (x, i) =>
          x.id === STAGES[i].id &&
          x.actor === STAGES[i].actor &&
          x.method === STAGES[i].method &&
          x.purpose === STAGES[i].purpose &&
          x.state === "completed" &&
          x.status === 200,
      ) &&
    state.entries[4].path === slot(0) &&
    state.entries[4].allocation === true &&
    state.entries[4].bodyBytes === 256 &&
    isCrossReadDenial(
      {
        id: e.id,
        actor: e.actor,
        method: "GET",
        purpose: "cross-read",
        path: e.path,
        expected: "deny",
      },
      e.status,
      r.error,
      r.object,
    )
  );
}
export class Ledger {
  private lockToken?: string;
  private previous = "GENESIS";
  state!: State;
  constructor(
    readonly directory: string,
    private readonly codec: Codec,
    private readonly fault?: (point: string) => void,
  ) {}
  initialize(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (
      existsSync(join(this.directory, "marker")) ||
      existsSync(join(this.directory, "journal")) ||
      existsSync(join(this.directory, "snapshot"))
    )
      throw new Error("LEDGER_ALREADY_INITIALIZED");
    this.acquire();
    try {
      durable(
        join(this.directory, "marker"),
        JSON.stringify({ run: RUN, manifestHash: MANIFEST_HASH }),
        "wx",
      );
      durable(join(this.directory, "journal"), "", "wx");
      this.state = {
        version: 1,
        run: RUN,
        bucket: BUCKET,
        manifestHash: MANIFEST_HASH,
        generation: 0,
        allocations: 0,
        bytes: 0,
        entries: [],
        sessions: {},
        resources: {},
      };
      this.commit();
    } finally {
      this.release();
    }
  }
  acquire(): void {
    if (this.lockToken) throw new Error("PROCESS_LOCK_CONTENTION");
    const token = randomUUID();
    try {
      durable(
        join(this.directory, "lock"),
        JSON.stringify({ token, pid: process.pid, run: RUN }),
        "wx",
      );
    } catch {
      throw new Error("PROCESS_LOCK_CONTENTION");
    }
    this.lockToken = token;
  }
  release(): void {
    if (!this.lockToken) return;
    const lock = JSON.parse(readFileSync(join(this.directory, "lock"), "utf8"));
    if (lock.token !== this.lockToken) throw new Error("PROCESS_LOCK_CHANGED");
    unlinkSync(join(this.directory, "lock"));
    this.lockToken = undefined;
  }
  private locked(): void {
    if (
      !this.lockToken ||
      JSON.parse(readFileSync(join(this.directory, "lock"), "utf8")).token !==
        this.lockToken
    )
      throw new Error("PROCESS_LOCK_REQUIRED");
  }
  load(): State {
    this.locked();
    try {
      if (existsSync(join(this.directory, "pending")))
        throw new Error("LEDGER_INCOMPLETE_COMMIT");
      const marker = JSON.parse(
        readFileSync(join(this.directory, "marker"), "utf8"),
      );
      if (marker.run !== RUN || marker.manifestHash !== MANIFEST_HASH)
        throw new Error("LEDGER_INTEGRITY");
      const text = readFileSync(join(this.directory, "journal"), "utf8");
      if (!text || !text.endsWith("\n"))
        throw new Error("LEDGER_PARTIAL_JOURNAL");
      let previous = "GENESIS";
      let last: Envelope | undefined;
      let state: State | undefined;
      for (const [i, line] of text.trimEnd().split("\n").entries()) {
        const row = JSON.parse(line) as Envelope;
        if (
          row.generation !== i ||
          row.previous !== previous ||
          row.digest !==
            hash(
              JSON.stringify({
                generation: row.generation,
                previous: row.previous,
                cipher: row.cipher,
              }),
            )
        )
          throw new Error("LEDGER_INTEGRITY");
        state = JSON.parse(this.codec.decode(row.cipher)) as State;
        integrity(state);
        if (state.generation !== row.generation)
          throw new Error("LEDGER_INTEGRITY");
        previous = row.digest;
        last = row;
      }
      if (
        !last ||
        !state ||
        readFileSync(join(this.directory, "snapshot"), "utf8") !==
          JSON.stringify(last)
      )
        throw new Error("LEDGER_SNAPSHOT_MISMATCH");
      this.previous = previous;
      this.state = state;
      return state;
    } catch {
      throw new Error("LEDGER_INTEGRITY_RECOVERY_REQUIRED");
    }
  }
  commit(): void {
    this.locked();
    integrity(this.state);
    const row = {
      generation: this.state.generation,
      previous: this.previous,
      cipher: this.codec.encode(JSON.stringify(this.state)),
    };
    const envelope: Envelope = { ...row, digest: hash(JSON.stringify(row)) };
    durable(
      join(this.directory, "journal"),
      JSON.stringify(envelope) + "\n",
      "a",
    );
    this.fault?.("after-journal-sync");
    durable(join(this.directory, "pending"), JSON.stringify(envelope), "wx");
    this.fault?.("before-snapshot-rename");
    renameSync(
      join(this.directory, "pending"),
      join(this.directory, "snapshot"),
    );
    this.previous = envelope.digest;
  }
  update(change: (state: State) => void): void {
    this.locked();
    change(this.state);
    this.state.generation++;
    this.commit();
  }
  approvalHistory() {
    this.load();
    const rows = readFileSync(join(this.directory, "journal"), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Envelope);
    return {
      identity: hash(
        JSON.stringify({
          directory: resolve(this.directory),
          marker: readFileSync(join(this.directory, "marker"), "utf8"),
          genesis: rows[0].digest,
        }),
      ),
      rows: rows.map((row) => ({
        generation: row.generation,
        digest: row.digest,
        state: JSON.parse(this.codec.decode(row.cipher)) as State,
      })),
    };
  }
  reserve(intent: Intent, allocation: boolean): Entry {
    if (this.state.renewalEvents?.some((e) => e.state !== "completed"))
      throw new Error("SESSION_RENEWAL_INTERRUPTED");
    if (
      this.isHalted() ||
      this.state.entries.some(
        (e) => e.state === "reserved" || e.state === "ambiguous",
      )
    )
      throw new Error("INTERRUPTED_RUN_RECOVERY_REQUIRED");
    if (this.state.entries.some((e) => e.id === intent.id))
      throw new Error("DUPLICATE_ATTEMPT_NO_RETRY");
    const n = intent.body?.byteLength ?? 0;
    if (
      this.state.allocations + Number(allocation) > MAX_ALLOCATIONS ||
      this.state.bytes + renewalBytes(this.state) + n > MAX_BYTES ||
      (this.isReconciled("cross-read-B") &&
        this.state.bytes + renewalBytes(this.state) + n > 6325536)
    )
      throw new Error("EXPERIMENT_BUDGET_EXHAUSTED");
    const entry: Entry = {
      sequence: this.state.entries.length + 1,
      id: intent.id,
      actor: intent.actor,
      bucket: BUCKET,
      path: intent.path,
      allocation,
      allocationAttempt: this.state.allocations + Number(allocation),
      method: intent.method,
      purpose: intent.purpose,
      bodyBytes: n,
      cumulativeBytes: this.state.bytes + n,
      resourceRef: intent.resource,
      state: "reserved",
      cleanup: "not-eligible",
    };
    this.update((s) => {
      s.allocations = entry.allocationAttempt;
      s.bytes = entry.cumulativeBytes;
      s.entries.push(entry);
    });
    return entry;
  }
  assertReservation(intent: Intent): void {
    this.locked();
    this.load(); // Validate encrypted journal, chain, snapshot and counters again.
    const entry = this.state.entries.at(-1);
    const allocation = validateIntent(
      intent,
      this.cleanupPreview().map((x) => x.path),
    ).allocation;
    if (
      !entry ||
      entry.state !== "reserved" ||
      entry.id !== intent.id ||
      entry.actor !== intent.actor ||
      entry.method !== intent.method ||
      entry.purpose !== intent.purpose ||
      entry.allocation !== allocation ||
      entry.path !== intent.path ||
      entry.bodyBytes !== (intent.body?.byteLength ?? 0)
    )
      throw new Error("DURABLE_RESERVATION_REQUIRED");
    // Re-read the committed snapshot envelope; HTTP is forbidden if any commit
    // failed or the snapshot/journal no longer represent this reservation.
    if (existsSync(join(this.directory, "pending")))
      throw new Error("DURABLE_RESERVATION_REQUIRED");
    const snapshot = JSON.parse(
      readFileSync(join(this.directory, "snapshot"), "utf8"),
    ) as Envelope;
    if (
      snapshot.generation !== this.state.generation ||
      snapshot.digest !== this.previous
    )
      throw new Error("DURABLE_RESERVATION_REQUIRED");
  }
  halt(reason: string): void {
    this.update((s) => {
      s.halted = reason;
    });
  }
  isReconciled(id: string): boolean {
    return (
      id === "cross-read-B" &&
      !!this.state.reconciliations?.some((r) =>
        validReconciliation(this.state, r),
      )
    );
  }
  isCompleted(id: string): boolean {
    return (
      this.state.entries.some((e) => e.id === id && e.state === "completed") ||
      this.isReconciled(id)
    );
  }
  continuationPlan() {
    if (
      this.isHalted() ||
      this.state.entries.some(
        (e) => e.state === "reserved" || e.state === "ambiguous",
      )
    )
      throw new Error("INTERRUPTED_RUN_RECOVERY_REQUIRED");
    const stages = STAGES.filter((s) => !this.isCompleted(s.id));
    const allocations = stages.filter((s) =>
      ["rest-upload", "wrong-owner-upload", "tus-create"].includes(s.purpose),
    ).length;
    const bytes = stages.reduce((n, s) => n + s.maxBytes, 0);
    if (
      this.state.allocations + allocations > 3 ||
      this.state.bytes + bytes > 6_325_536
    )
      throw new Error("FIRST_WAVE_BUDGET_EXHAUSTED");
    return {
      stages: stages.map((s) => s.id),
      allocationAttempts: allocations,
      maximumBodyBytes: bytes,
    };
  }
  isHalted(): boolean {
    if (!this.state.halted) return false;
    return !(
      this.state.halted === "DENIAL_NOT_ESTABLISHED" &&
      this.isReconciled("cross-read-B") &&
      this.state.entries.every(
        (e) => e.state !== "failed" || e.id === "cross-read-B",
      )
    );
  }
  knownObject(): KnownObject | undefined {
    return this.state.reconciliations?.find((r) =>
      validReconciliation(this.state, r),
    )?.object;
  }
  reconcileCrossRead(record: DenialReconciliation): void {
    this.locked();
    this.load();
    if (
      this.state.reconciliations?.length ||
      this.state.entries.length !== 7 ||
      this.state.halted !== "DENIAL_NOT_ESTABLISHED" ||
      this.state.allocations !== 1 ||
      this.state.bytes !== 474 ||
      !validReconciliation(this.state, record) ||
      Object.keys(this.state.resources).length !== 0 ||
      !this.state.sessions.A?.verified ||
      !this.state.sessions.B?.verified
    )
      throw new Error("RECONCILIATION_PRECONDITION_FAILED");
    // Append a new encrypted generation. Original failed entry, halt and counters
    // are retained; no prior journal row is rewritten and no request is replayed.
    this.update((s) => {
      s.reconciliations = [structuredClone(record)];
    });
  }
  observeOwner(
    path: string,
    owner: string,
    source = "user-supplied-read-only-catalog-evidence",
  ): void {
    if (!PATHS.some((p) => p.path === path))
      throw new Error("PATH_NOT_ALLOWLISTED");
    this.update((s) => {
      for (const e of s.entries)
        if (
          e.path === path &&
          e.allocation &&
          e.state === "completed" &&
          e.actor !== "anonymous"
        ) {
          e.owner = owner;
          e.ownerSource = source;
          e.cleanup =
            owner === USERS[e.actor].id &&
            PATHS.some((p) => p.path === path && p.actor === e.actor) &&
            e.purpose !== "wrong-owner-upload" &&
            (e.purpose !== "tus-create" ||
              Object.values(s.resources).some(
                (r) => r.path === path && r.complete,
              ))
              ? "eligible"
              : "not-eligible";
        }
    });
  }
  cleanupPreview(): { actor: "A" | "B"; path: string; slot: number }[] {
    const seen = new Set<string>();
    return this.state.entries.flatMap((e) => {
      if (
        e.actor === "anonymous" ||
        !e.path ||
        e.cleanup !== "eligible" ||
        e.state !== "completed" ||
        e.owner !== USERS[e.actor].id ||
        !PATHS.some((p) => p.path === e.path && p.actor === e.actor) ||
        seen.has(e.path)
      )
        return [];
      seen.add(e.path);
      return [
        {
          actor: e.actor,
          path: e.path,
          slot: PATHS.findIndex((p) => p.path === e.path),
        },
      ];
    });
  }
}
