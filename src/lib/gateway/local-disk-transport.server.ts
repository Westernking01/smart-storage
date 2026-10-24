import "server-only";
import { createHash } from "node:crypto";
import { open, lstat, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Worker } from "node:worker_threads";
import type { StorageTransport, WriteIntent } from "./provider-contracts";
import { intentSchema, permitSchema } from "./supabase-storage-provider.server";

// One synchronous filesystem writer, one outstanding <=64 KiB message. No SDK,
// multipart resource, temporary copy, rename, overwrite or detached I/O exists.
const writerProgram = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const crypto = require('node:crypto');
let fd, total=0; const hash=crypto.createHash('sha256');
try {
 fd=fs.openSync(workerData.path,'wx',0o600);
 parentPort.postMessage('ready');
 parentPort.on('message', m => {
  try {
   if(m.end) {
    if(total!==workerData.length || hash.digest('hex')!==workerData.hash) throw Error();
    fs.fsyncSync(fd); fs.closeSync(fd); fd=undefined;
    parentPort.postMessage('complete'); parentPort.close(); return;
   }
   const b=m.bytes;
   if(!(b instanceof Uint8Array) || b.length>65536 || total+b.length>workerData.length) throw Error();
   let n=0; while(n<b.length) { const wrote=fs.writeSync(fd,b,n,b.length-n); if(!wrote) throw Error(); n+=wrote; }
   total+=b.length; hash.update(b); parentPort.postMessage('ack');
  } catch { if(fd!==undefined) fs.closeSync(fd); parentPort.postMessage('failed'); parentPort.close(); }
 });
} catch { parentPort.postMessage('failed'); parentPort.close(); }
`;

type Active = {
  worker?: Worker;
  terminal: Promise<void>;
  stop: () => void;
  binding: string;
};
const fail = (code: string): never => {
  throw new Error(code);
};

/** Replacement candidate for ONE private local volume, not a cloud certificate.
 * Root must already exist, be exclusively writable by the supervisor and never
 * be served statically. Independent instances share permanent exclusive claims.
 * Crash recovery deliberately cannot issue removal proof from a new instance:
 * an external supervisor must first prove every old process is dead. No TTL.
 */
export class LocalDiskTransport implements StorageTransport {
  private readonly active = new Map<string, Active>();
  private readonly terminal = new Map<string, string>();
  private readonly readers = new Map<string, number>();
  private readonly removing = new Set<string>();
  private readonly root: string;

  constructor(
    root: string,
    private readonly maximumWriters = 1,
    private readonly deadlineMs = 30_000,
  ) {
    this.root = resolve(root);
    if (
      !Number.isSafeInteger(maximumWriters) ||
      maximumWriters < 1 ||
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > 2_147_483_647
    )
      fail("INVALID_LIMITS");
  }
  assertSupported(operation: string) {
    if (operation !== "single-object-create") fail("UNSUPPORTED_CAPABILITY");
  }
  private key(intent: WriteIntent) {
    return createHash("sha256")
      .update(JSON.stringify([intent.bucket, intent.path]))
      .digest("hex");
  }
  async create(input: Parameters<StorageTransport["create"]>[0]) {
    const intent = intentSchema.parse(input.intent);
    const permit = permitSchema.parse(input.permit);
    this.assertSupported(intent.operation);
    if (
      Object.keys(intent).some(
        (k) =>
          intent[k as keyof WriteIntent] !==
          permit.intent[k as keyof WriteIntent],
      ) ||
      permit.maximumEncodedBytes !== intent.declaredBytes ||
      permit.reservedExposureBytes < intent.declaredBytes ||
      (intent.declaredBytes === 0 && !permit.allowZeroBytes) ||
      input.options.contentLength !== intent.declaredBytes ||
      input.options.upsert !== false ||
      input.options.retries !== 0 ||
      input.options.redirect !== "error" ||
      input.options.contentType !== "application/octet-stream"
    )
      fail("INVALID_GRANT");
    if (input.signal.aborted) fail("ABORTED");
    if (this.active.size >= this.maximumWriters) fail("WRITER_CAPACITY");
    const key = this.key(intent);
    if (this.active.has(key) || this.terminal.has(key)) fail("REPLAY_DENIED");
    let release!: () => void;
    const active: Active = {
      binding: JSON.stringify(intent),
      terminal: new Promise<void>((r) => {
        release = r;
      }),
      stop: () => {},
    };
    // Register before the first await so cleanup cannot race writer startup.
    this.active.set(key, active);
    let stopped = false;
    let rejectStop!: (error: Error) => void;
    const stop = new Promise<never>((_, reject) => {
      rejectStop = reject;
    });
    // Attach rejection handler immediately, even during claim creation.
    void stop.catch(() => {});
    active.stop = () => {
      stopped = true;
      rejectStop(new Error("ABORTED"));
    };
    input.signal.addEventListener("abort", active.stop, { once: true });
    const timer = setTimeout(active.stop, this.deadlineMs);
    let claimCreated = false;
    try {
      const rootStat = await lstat(this.root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        fail("UNSAFE_ROOT");
      // Claim is never deleted. It fences replay across processes/restarts,
      // including a crash between claim persistence and starting the writer.
      const claim = await open(join(this.root, key + ".claim"), "wx", 0o600);
      claimCreated = true;
      try {
        await claim.sync();
      } finally {
        await claim.close();
      }
      if (stopped) fail("ABORTED");
      const worker = new Worker(writerProgram, {
        eval: true,
        trackUnmanagedFds: true,
        workerData: {
          path: join(this.root, key + ".object"),
          length: intent.declaredBytes,
          hash: intent.expectedSha256,
        },
      });
      active.worker = worker;
      const next = () =>
        new Promise<string>((resolveMessage, reject) => {
          const message = (value: string) => {
            clear();
            if (value === "failed") reject(new Error("WRITER_FAILED"));
            else resolveMessage(value);
          };
          const error = () => {
            clear();
            reject(new Error("WRITER_FAILED"));
          };
          const clear = () => {
            worker.off("message", message);
            worker.off("error", error);
            worker.off("exit", error);
          };
          worker.once("message", message);
          worker.once("error", error);
          worker.once("exit", error);
        });
      // Persistent handler prevents an unhandled worker error between messages.
      worker.on("error", active.stop);
      if ((await Promise.race([next(), stop])) !== "ready")
        fail("WRITER_FAILED");
      let total = 0;
      const iterator = input.body[Symbol.asyncIterator]();
      for (;;) {
        const item = await Promise.race([iterator.next(), stop]);
        if (stopped) fail("ABORTED");
        if (item.done) break;
        const b = item.value;
        if (
          !(b instanceof Uint8Array) ||
          b.byteLength > 65_536 ||
          total + b.byteLength > intent.declaredBytes
        )
          fail("STREAM_TOO_LARGE");
        total += b.byteLength;
        const ack = next();
        worker.postMessage({ bytes: Uint8Array.from(b) });
        if ((await Promise.race([ack, stop])) !== "ack") fail("WRITER_FAILED");
      }
      if (total !== intent.declaredBytes) fail("STREAM_TRUNCATED");
      const complete = next();
      worker.postMessage({ end: true });
      if ((await Promise.race([complete, stop])) !== "complete")
        fail("WRITER_FAILED");
      return {
        kind: "response",
        status: 201,
        provenance: "authenticated-storage-response",
        requestId: intent.requestId,
        version: null,
        etag: null,
        acknowledgedBytes: total,
      } as const;
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", active.stop);
      try {
        // Never publish a terminal fact until actual worker exit is acknowledged.
        if (active.worker) await active.worker.terminate();
        if (claimCreated) this.terminal.set(key, active.binding);
      } finally {
        this.active.delete(key);
        release();
      }
    }
  }

  /** A local supervisor fact only. Does NOT settle PostgreSQL quota or certify
   * remote deletion. Failure/restart/unknown writer retains all DB liability.
   */
  async terminateAndRemove(intent: WriteIntent) {
    intentSchema.parse(intent);
    const key = this.key(intent);
    const writer = this.active.get(key);
    const binding = JSON.stringify(intentSchema.parse(intent));
    if ((writer?.binding ?? this.terminal.get(key)) !== binding)
      fail("WRITER_TERMINATION_UNPROVEN");
    // Fence new readers before the first await. Open readers can retain file
    // bytes after unlink on some filesystems; keep liability until they close.
    this.removing.add(key);
    if (this.readers.get(key)) fail("READERS_ACTIVE");
    if (writer) {
      writer.stop();
      await writer.terminal;
    }
    if (!this.terminal.has(key)) fail("WRITER_TERMINATION_UNPROVEN");
    await rm(join(this.root, key + ".object"), { force: true });
    try {
      await lstat(join(this.root, key + ".object"));
      fail("REMOVAL_UNCONFIRMED");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      scope: "local-process-and-volume",
      writerTerminated: true,
      objectAbsent: true,
      retainDatabaseHolds: true,
    } as const;
  }

  /** Read only a DB-resolved immutable object. Client restoration independently
   * verifies encoded and original hashes before committing its destination. */
  async *read(intent: WriteIntent) {
    intentSchema.parse(intent);
    const key = this.key(intent);
    if (this.removing.has(key)) fail("REMOVAL_IN_PROGRESS");
    this.readers.set(key, (this.readers.get(key) ?? 0) + 1);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const path = join(this.root, key + ".object");
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== intent.declaredBytes
      )
        fail("OBJECT_INTEGRITY");
      handle = await open(path, "r");
      let offset = 0;
      while (offset < intent.declaredBytes) {
        const buffer = new Uint8Array(
          Math.min(65536, intent.declaredBytes - offset),
        );
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          offset,
        );
        if (!bytesRead) fail("OBJECT_INTEGRITY");
        offset += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    } finally {
      await handle?.close();
      const remaining = (this.readers.get(key) ?? 1) - 1;
      if (remaining) this.readers.set(key, remaining);
      else this.readers.delete(key);
    }
  }
}
