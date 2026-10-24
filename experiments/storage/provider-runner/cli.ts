import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Ledger } from "./ledger.js";
import { assertContinuation } from "./continuation.js";
import { renewalBytes } from "./renewal-evidence.js";
import {
  approve,
  slot,
  fixture,
  CHUNK_BYTES,
  type Approval,
  type Intent,
} from "./manifest.js";
import { dryRun, Runner, safeError, summary } from "./runner.js";
import { ProviderHttp, publicConfiguration } from "./transport.js";
import {
  WindowsCodec,
  ProtectedCredentials,
  privateFile,
  canonicalDirectory,
  initializePrivateDirectory,
  checkDirectory,
} from "./windows-store.js";

export interface PrivateExecution {
  ledger: Ledger;
  permission: Approval;
  confirmation: string;
  check: () => void;
}
export async function runCli(
  args = process.argv.slice(2),
  privateExecution?: PrivateExecution,
): Promise<void> {
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const execute = args.includes("--execute");
  const preview = args.includes("--cleanup-preview");
  const initialize = args.includes("--initialize-ledger");
  const observations = value("--owner-evidence");
  if (
    Number(execute) +
      Number(preview) +
      Number(initialize) +
      Number(Boolean(observations)) >
    1
  )
    throw new Error("CHOOSE_ONE_MODE");
  if (!execute && !preview && !initialize && !observations) {
    console.log(JSON.stringify(dryRun(), null, 2));
    return;
  }
  const repository = resolve(process.cwd());
  const codec = new WindowsCodec();
  if (initialize) {
    const dir = initializePrivateDirectory(repository);
    new Ledger(dir, codec).initialize();
    console.log(
      JSON.stringify({ localLedgerInitialized: true, providerRequests: 0 }),
    );
    return;
  }
  let permission: Approval | undefined;
  if (execute) {
    if (privateExecution) {
      if (args.length !== 1 || args[0] !== "--execute")
        throw new Error("PRIVATE_CONTINUATION_ONLY");
      privateExecution.check();
      permission = approve(
        privateExecution.permission,
        privateExecution.confirmation,
      );
      if (permission.schemaVersion !== 2)
        throw new Error("CONTINUATION_APPROVAL_REQUIRED");
    } else {
      const file = value("--approval-file");
      if (!file) throw new Error("APPROVAL_REQUIRED");
      permission = approve(
        JSON.parse(readFileSync(privateFile(file, repository), "utf8")),
        value("--confirm"),
      );
    }
  }
  const directory = canonicalDirectory();
  checkDirectory(directory, repository);
  // There is only one canonical production ledger for this immutable run. Missing
  // state never triggers initialization, alternate directories or budget reset.
  for (const file of ["marker", "journal", "snapshot"])
    privateFile(resolve(directory, file), repository);
  const ledger = privateExecution?.ledger ?? new Ledger(directory, codec);
  if (privateExecution && resolve(ledger.directory) !== resolve(directory))
    throw new Error("CANONICAL_PRIVATE_LEDGER_REQUIRED");
  if (!privateExecution) ledger.acquire();
  try {
    ledger.load();
    if (preview) {
      console.log(
        JSON.stringify({
          cleanupPreview: ledger
            .cleanupPreview()
            .map((x) => ({ actor: x.actor, slot: x.slot })),
          providerRequests: 0,
          deletionAuthorized: false,
          incompleteTusResources: Object.values(ledger.state.resources).filter(
            (r) => !r.complete,
          ).length,
        }),
      );
      return;
    }
    if (observations) {
      const evidence = JSON.parse(
        readFileSync(privateFile(observations, repository), "utf8"),
      ) as { run: string; records: { path: string; owner: string }[] };
      if (
        evidence.run !== ledger.state.run ||
        !Array.isArray(evidence.records) ||
        evidence.records.length > 2 ||
        ledger.state.halted ||
        ledger.state.entries.some(
          (e) => e.state === "reserved" || e.state === "ambiguous",
        )
      )
        throw new Error("OWNER_EVIDENCE_REVIEW_REQUIRED");
      for (const row of evidence.records)
        ledger.observeOwner(row.path, row.owner);
      console.log(
        JSON.stringify({
          localOwnerEvidenceRecorded: true,
          source: "USER_SUPPLIED_READ_ONLY_CATALOG",
          providerRequests: 0,
        }),
      );
      return;
    }
    if (
      ledger.isHalted() ||
      ledger.state.entries.some(
        (e) => e.state === "reserved" || e.state === "ambiguous",
      )
    )
      throw new Error("INTERRUPTED_RUN_RECOVERY_REQUIRED");
    const credentialsFile = value("--credentials-file");
    ledger.continuationPlan(); // Fixed-stage continuation must fit the smaller first-wave caps.
    assertContinuation(ledger, permission!);
    if (!credentialsFile && !privateExecution)
      throw new Error("PRIVATE_CREDENTIAL_FILE_REQUIRED");
    const config = publicConfiguration(resolve(repository, ".env.local"));
    const confirmation = privateExecution?.confirmation ?? value("--confirm");
    const http = new ProviderHttp(config.key, ledger, permission, confirmation);
    const transport = privateExecution
      ? {
          send: async (...request: Parameters<ProviderHttp["send"]>) => {
            privateExecution.check();
            return http.send(...request);
          },
        }
      : http;
    const runner = new Runner(
      ledger,
      transport,
      permission,
      confirmation,
      false,
    );
    const credentials = privateExecution
      ? {
          get: () => {
            throw new Error("CONTINUATION_AUTH_REPLAY_FORBIDDEN");
          },
        }
      : new ProtectedCredentials(credentialsFile!, repository);
    await runner.authenticate("A", credentials);
    await runner.authenticate("B", credentials);
    const tus = fixture(CHUNK_BYTES + 1_024);
    const request = async (intent: Intent) => {
      if (ledger.isCompleted(intent.id)) return;
      await runner.send(intent);
      console.log(
        JSON.stringify({
          request: intent.id,
          status: ledger.state.entries.at(-1)?.status,
          attemptedAllocations: ledger.state.allocations,
          attemptedBodyBytes: ledger.state.bytes + renewalBytes(ledger.state),
        }),
      );
    };
    await request({
      id: "rest-A",
      actor: "A",
      purpose: "rest-upload",
      method: "POST",
      path: slot(0),
      body: fixture(256),
      expected: "allow",
    });
    await request({
      id: "download-A",
      actor: "A",
      purpose: "download",
      method: "GET",
      path: slot(0),
      expected: "allow",
    });
    await request({
      id: "cross-read-B",
      actor: "B",
      purpose: "cross-read",
      method: "GET",
      path: slot(0),
      expected: "deny",
    });
    await request({
      id: "wrong-owner-B",
      actor: "B",
      purpose: "wrong-owner-upload",
      method: "POST",
      path: slot(1),
      body: fixture(32),
      expected: "deny",
    });
    await request({
      id: "anonymous-read",
      actor: "anonymous",
      purpose: "anonymous-read",
      method: "GET",
      path: slot(0),
      expected: "deny",
    });
    await request({
      id: "tus-create-A",
      actor: "A",
      purpose: "tus-create",
      method: "POST",
      path: slot(2),
      expected: "allow",
    });
    const resource = ledger.state.entries.find(
      (e) => e.id === "tus-create-A",
    )?.resourceRef;
    if (!resource) throw new Error("RESOURCE_BINDING_REQUIRED");
    await request({
      id: "tus-head-zero",
      actor: "A",
      purpose: "tus-head",
      method: "HEAD",
      path: slot(2),
      resource,
      expected: "allow",
    });
    await request({
      id: "tus-part-first",
      actor: "A",
      purpose: "tus-part",
      method: "PATCH",
      path: slot(2),
      resource,
      offset: 0,
      body: tus.subarray(0, CHUNK_BYTES),
      expected: "allow",
    });
    await request({
      id: "tus-head-recovery",
      actor: "A",
      purpose: "tus-head",
      method: "HEAD",
      path: slot(2),
      resource,
      expected: "allow",
    });
    await request({
      id: "tus-part-tail",
      actor: "A",
      purpose: "tus-part",
      method: "PATCH",
      path: slot(2),
      resource,
      offset: CHUNK_BYTES,
      body: tus.subarray(CHUNK_BYTES),
      expected: "allow",
    });
    await request({
      id: "tus-head-complete",
      actor: "A",
      purpose: "tus-head",
      method: "HEAD",
      path: slot(2),
      resource,
      expected: "allow",
    });
    await request({
      id: "owner-info-rest",
      actor: "A",
      purpose: "owner-info",
      method: "GET",
      path: slot(0),
      expected: "allow",
    });
    await request({
      id: "owner-info-tus",
      actor: "A",
      purpose: "owner-info",
      method: "GET",
      path: slot(2),
      expected: "allow",
    });
    console.log(
      JSON.stringify({
        ...summary(ledger),
        ownerVerificationPending: ledger.cleanupPreview().length < 2,
        cleanupExecuted: false,
      }),
    );
  } finally {
    if (!privateExecution) ledger.release();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void runCli().catch((error) => {
    console.log(
      JSON.stringify({
        stopped: true,
        code: safeError(error),
        secretsSuppressed: true,
      }),
    );
    process.exitCode = 1;
  });

// No production imports or npm script wiring. Cleanup is preview-only in this CLI.
