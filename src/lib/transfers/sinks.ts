import { fail } from "./format";
import type { RestoreSink } from "./restore";
export function writableSink(
  writable: FileSystemWritableFileStream,
): RestoreSink {
  return {
    write: (bytes) => writable.write(bytes),
    commit: () => writable.close(),
    abort: (reason) => writable.abort(reason),
  };
}
export async function localDestination(
  id: string,
  ownerId?: string,
  maximum = Infinity,
) {
  if (ownerId && !/^[a-f0-9-]{36}$/.test(ownerId))
    fail("STAGING_OWNER_INVALID");
  if (!navigator.storage?.getDirectory) {
    if (!Number.isFinite(maximum)) fail("STREAMING_DESTINATION_UNSUPPORTED");
    let chunks: Uint8Array<ArrayBuffer>[] = [],
      size = 0,
      ready = false;
    return {
      sink: {
        write: async (bytes: Uint8Array<ArrayBuffer>) => {
          if (size + bytes.length > maximum) fail("RESTORED_SIZE_LIMIT");
          chunks.push(bytes.slice());
          size += bytes.length;
        },
        commit: async () => {
          ready = true;
        },
        abort: async () => {
          chunks = [];
          size = 0;
          ready = false;
        },
      },
      file: async () => {
        if (!ready) fail("RESTORATION_NOT_VERIFIED");
        return new File(chunks, "restored");
      },
      remove: async () => {
        chunks = [];
        size = 0;
        ready = false;
      },
    };
  }
  const root = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle(
    ownerId
      ? `smart-storage-account-restores-v1-${ownerId}`
      : "smart-storage-local-restores-v1",
    { create: true },
  );
  const name = `${id}-${crypto.randomUUID()}.partial`;
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  const sink = writableSink(writable);
  let size = 0,
    ready = false;
  const remove = async () => {
    ready = false;
    try {
      await root.removeEntry(name);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError"))
        throw error;
    }
  };
  return {
    sink: {
      ...sink,
      write: async (bytes: Uint8Array<ArrayBuffer>) => {
        if (size + bytes.length > maximum) fail("RESTORED_SIZE_LIMIT");
        size += bytes.length;
        await sink.write(bytes);
      },
      commit: async () => {
        await sink.commit();
        ready = true;
      },
      abort: async (reason: unknown) => {
        ready = false;
        await writable.abort(reason).catch(() => {});
        await remove();
      },
    },
    file: () => {
      if (!ready) fail("RESTORATION_NOT_VERIFIED");
      return handle.getFile();
    },
    remove,
  };
}
