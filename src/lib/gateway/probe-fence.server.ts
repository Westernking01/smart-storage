import "server-only";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

/** Trusted server-only directory, provisioned separately with restricted ACLs.
 * Never remove claim files to retry a lost/ambiguous probe. No automatic mkdir.
 * Exclusive creation fences other processes and restarts; fsync precedes I/O. */
export class FileProbeFence {
  constructor(private readonly directory: string) {
    if (!isAbsolute(directory))
      throw Error("ABSOLUTE_PROBE_EVIDENCE_DIRECTORY_REQUIRED");
  }
  async claim(authorizationId: string, kind: string) {
    const name = createHash("sha256")
      .update(JSON.stringify(["read-only-probe-v1", authorizationId, kind]))
      .digest("hex");
    const file = await open(join(this.directory, name + ".claim"), "wx", 0o600);
    try {
      await file.writeFile("consumed\n");
      await file.sync();
    } finally {
      await file.close();
    }
  }
}
