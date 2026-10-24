import { createInterface } from "node:readline/promises";
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { Ledger } from "./ledger.js";
import {
  renewalCandidate,
  renewSessions,
  NativeRenewalHttp,
} from "./renewal.js";
import {
  renewalBytes,
  approveRenewal,
  type RenewalApproval,
} from "./renewal-evidence.js";
import {
  canonicalDirectory,
  checkDirectory,
  privateFile,
  WindowsCodec,
  ProtectedCredentials,
  createPrivateApproval,
} from "./windows-store.js";
import { publicConfiguration } from "./transport.js";
import { safeError } from "./runner.js";
async function main() {
  const args = process.argv.slice(2);
  if (
    args[0] !== "--renew" ||
    args.length !== 3 ||
    args[1] !== "--credentials-file" ||
    !process.stdin.isTTY
  )
    throw new Error("INTERACTIVE_RENEWAL_ONLY");
  const repository = resolve(process.cwd()),
    directory = canonicalDirectory();
  const acl = () => {
    checkDirectory(directory, repository);
    for (const f of ["marker", "journal", "snapshot"])
      privateFile(join(directory, f), repository);
  };
  acl();
  const credentialsFile = privateFile(resolve(args[2]), repository);
  const config = publicConfiguration(resolve(repository, ".env.local"));
  const ledger = new Ledger(directory, new WindowsCodec());
  ledger.acquire();
  try {
    ledger.load();
    renewalCandidate(ledger); // Validates expired identities/checkpoint, no credential read or mutation.
    console.log(
      "Target: mdyiczsuddpqgjtfofgs / smart-storage-feasibility / p14b-20261011-c40e8e03. Ordinary test identities A and B only. This command does not execute the Storage continuation.",
    );
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let answer: string;
    try {
      answer = await prompt.question(
        "Auth-only renewal: exactly A login/identity then B login/identity; no Storage requests. Maximum 32,550 Auth body bytes within unchanged cumulative limits; no retries. Type RENEW TWO TEST SESSIONS to authorize: ",
      );
    } finally {
      prompt.close();
    }
    if (answer !== "RENEW TWO TEST SESSIONS")
      throw new Error("SESSION_RENEWAL_NOT_CONFIRMED");
    acl();
    const candidate = renewalCandidate(ledger);
    const file = createPrivateApproval(candidate, repository);
    const permission = JSON.parse(
      readFileSync(privateFile(file, repository), "utf8"),
    ) as RenewalApproval;
    approveRenewal(permission, candidate.id);
    const check = () => {
      acl();
      privateFile(file, repository);
      if (readFileSync(file, "utf8") !== JSON.stringify(candidate))
        throw new Error("SESSION_RENEWAL_APPROVAL_CHANGED");
    };
    await renewSessions(
      ledger,
      permission,
      candidate.id,
      new ProtectedCredentials(credentialsFile, repository),
      new NativeRenewalHttp(
        config.key,
        permission,
        candidate.id,
        check,
        ledger,
      ),
      check,
    );
    console.log(
      JSON.stringify({
        result: "SESSIONS_RENEWED_AND_IDENTITY_VERIFIED",
        authRequests: 4,
        storageRequests: 0,
        allocations: ledger.state.allocations,
        stageBodyBytes: ledger.state.bytes,
        renewalBodyBytes: renewalBytes(ledger.state),
        totalAttemptedBodyBytes:
          ledger.state.bytes + renewalBytes(ledger.state),
        continuationExecuted: false,
      }),
    );
  } finally {
    ledger.release();
  }
}
void main().catch((error) => {
  console.log(
    JSON.stringify({
      stopped: true,
      code: safeError(error),
      secretsSuppressed: true,
    }),
  );
  process.exitCode = 1;
});
