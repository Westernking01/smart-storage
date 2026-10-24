import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Ledger } from "./ledger.js";
import {
  confirmContinuation,
  continuationResult,
  invokePrivateContinuation,
} from "./continuation-helper.js";
import {
  canonicalDirectory,
  checkDirectory,
  privateFile,
  WindowsCodec,
  createPrivateApproval,
  ProtectedCredentials,
} from "./windows-store.js";
import {
  confirmSecondRenewal,
  renewSessions,
  NativeRenewalHttp,
} from "./renewal.js";
import { publicConfiguration } from "./transport.js";
import { safeError } from "./runner.js";
import { renewalDiagnostic } from "./renewal-diagnostic.js";
export async function continuationHelperCli(
  args = process.argv.slice(2),
): Promise<void> {
  if (
    args.length !== 1 ||
    ![
      "--execute",
      "--inspect",
      "--diagnose-renewal",
      "--renew-then-continue",
    ].includes(args[0])
  )
    throw new Error("CONTINUATION_HELPER_MODE_REQUIRED");
  if (
    !["--inspect", "--diagnose-renewal"].includes(args[0]) &&
    !process.stdin.isTTY
  )
    throw new Error("INTERACTIVE_CONTINUATION_ONLY");
  const repository = resolve(process.cwd()),
    directory = canonicalDirectory();
  const check = () => {
    checkDirectory(directory, repository);
    for (const f of ["marker", "journal", "snapshot"])
      privateFile(join(directory, f), repository);
  };
  check();
  const ledger = new Ledger(directory, new WindowsCodec());
  ledger.acquire();
  try {
    ledger.load();
    if (args[0] === "--diagnose-renewal") {
      console.log(JSON.stringify(renewalDiagnostic(ledger), null, 2));
      return;
    }
    if (args[0] === "--inspect") {
      console.log(JSON.stringify(continuationResult(ledger), null, 2));
      return;
    }
    const config = publicConfiguration(join(repository, ".env.local")); // No network.
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let approved: Awaited<ReturnType<typeof confirmContinuation>>;
    try {
      if (args[0] === "--renew-then-continue") {
        const { permission: p, file } = await confirmSecondRenewal(
          ledger,
          (text) => prompt.question(text),
          (value) => createPrivateApproval(value, repository),
          check,
        );
        const authCheck = () => {
          check();
          privateFile(file, repository);
          if (readFileSync(file, "utf8") !== JSON.stringify(p))
            throw new Error("SESSION_RENEWAL_APPROVAL_CHANGED");
        };
        const credentials = join(
          process.env.USERPROFILE!,
          "smart-storage-feasibility-secrets-20261011-05879c0446444796a320bffc58709281",
          "completed.dpapi",
        );
        privateFile(credentials, repository);
        await renewSessions(
          ledger,
          p,
          p.id,
          new ProtectedCredentials(credentials, repository),
          new NativeRenewalHttp(config.key, p, p.id, authCheck, ledger),
          authCheck,
        );
        console.log(
          "SECOND_SESSIONS_RENEWED_AND_IDENTITY_VERIFIED; 4 Auth requests; 0 Storage requests. Separate Storage confirmation follows.",
        );
        console.log(
          JSON.stringify({
            sessionLifetime: continuationResult(ledger).sessionLifetime,
            requiredRemainingSeconds: 1800,
          }),
        );
      }
      approved = await confirmContinuation(
        ledger,
        (p) => prompt.question(p),
        (p) => createPrivateApproval(p, repository),
        check,
      );
    } finally {
      prompt.close();
    }
    const approvalCheck = () => {
      check();
      privateFile(approved.file, repository);
      if (
        readFileSync(approved.file, "utf8") !==
        JSON.stringify(approved.permission)
      )
        throw new Error("CONTINUATION_APPROVAL_CHANGED");
    };
    let error: string | undefined;
    try {
      await invokePrivateContinuation({
        ledger,
        permission: approved.permission,
        confirmation: approved.permission.id,
        check: approvalCheck,
      });
    } catch (e) {
      error = safeError(e);
    }
    // Re-load before claiming any durable outcome; an incomplete commit must
    // stop reporting rather than invent a reconciled state or clear the lock.
    approvalCheck();
    ledger.load();
    const result = continuationResult(ledger, error);
    const report = join(dirname(approved.file), "result.json");
    writeFileSync(report, JSON.stringify(result, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    privateFile(report, repository);
    console.log(
      JSON.stringify({ ...result, privateResultFile: report }, null, 2),
    );
    if (result.classification !== "FIRST WAVE PASSED") process.exitCode = 1;
  } finally {
    ledger.release();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void continuationHelperCli().catch((e) => {
    console.log(
      JSON.stringify({
        classification: "FIRST WAVE STOPPED / INCOMPLETE",
        code: safeError(e),
        secretsSuppressed: true,
        cleanupExecuted: false,
      }),
    );
    process.exitCode = 1;
  });
