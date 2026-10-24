// Compile the existing server-only modules into an isolated CLI graph.
import ts from "typescript";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (
  process.argv.length !== 3 ||
  !["--check", "--execute"].includes(mode) ||
  process.env.NODE_OPTIONS ||
  process.execArgv.length
) {
  console.error("FAIL: POOL_LIFECYCLE_FAILED");
  process.exitCode = 1;
} else {
  try {
    const out = new URL(
      "../.cache/pool-isolation-qualification/",
      import.meta.url,
    );
    mkdirSync(out, { recursive: true });
    const modules = {
      runner: "scripts/pool-isolation-qualification.ts",
      errors: "scripts/pool-isolation-errors.ts",
      lifecycle: "scripts/pool-isolation-lifecycle.ts",
      enrollment: "scripts/enrollment-auth-qualification.ts",
      tls: "scripts/publisher-tls-qualification.ts",
      adapter: "src/lib/backend/development-publisher-postgres.server.ts",
      verifier: "src/lib/backend/development-user-verifier.server.ts",
      identity: "src/lib/backend/identity.ts",
    };
    const replacements = {
      "./pool-isolation-errors": "./errors.mjs",
      "./pool-isolation-lifecycle": "./lifecycle.mjs",
      "./enrollment-auth-qualification": "./enrollment.mjs",
      "./publisher-tls-qualification": "./tls.mjs",
      "../src/lib/backend/development-publisher-postgres.server":
        "./adapter.mjs",
      "./development-user-verifier.server": "./verifier.mjs",
      "./identity": "./identity.mjs",
    };
    for (const [name, path] of Object.entries(modules)) {
      let source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
      for (const [from, to] of Object.entries(replacements))
        source = source.replaceAll(`"${from}"`, `"${to}"`);
      writeFileSync(
        new URL(`${name}.mjs`, out),
        ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
          },
        }).outputText,
      );
    }
    // Check loads the complete compiled graph, but the internal execution marker
    // is absent: no env loading, Auth client, credential read or Pool construction.
    const result = spawnSync(
      process.execPath,
      [
        "--conditions=react-server",
        fileURLToPath(new URL("runner.mjs", out)),
        mode === "--execute" ? "--pool-execute" : "--check",
      ],
      { encoding: "utf8", shell: false, timeout: 130000, maxBuffer: 16384 },
    );
    const { childFailureLine } = await import(new URL("errors.mjs", out));
    process.exitCode = result.status ?? 1;
    if (result.stderr?.length) process.exitCode = 1;
    // Never forward a child stack/driver diagnostic. Success is one fixed-size
    // JSON evidence record; every other exit receives a constant failure line.
    if (process.exitCode !== 0) {
      console.error(
        childFailureLine(
          result.stderr ?? "",
          Boolean(result.error || result.signal),
        ),
      );
    } else if (mode === "--execute") {
      try {
        const evidence = JSON.parse(result.stdout);
        const keys = [
          "status",
          "probes",
          "queries",
          "sessions",
          "maximumActive",
          "queued",
          "crossUser",
          "authDispatches",
          "connections",
        ];
        if (
          Object.keys(evidence).length !== keys.length ||
          keys.some((key) => !Object.hasOwn(evidence, key)) ||
          !["PASS", "PARTIAL"].includes(evidence.status) ||
          evidence.probes !== 6 ||
          evidence.sessions !== 2 ||
          evidence.maximumActive !== 2 ||
          evidence.queued !== true ||
          evidence.connections !== 2 ||
          !["PASS", "BLOCKED_SECOND_ACCOUNT_UNAVAILABLE"].includes(
            evidence.crossUser,
          ) ||
          !Number.isInteger(evidence.queries) ||
          evidence.queries < 0 ||
          evidence.queries > 120 ||
          !Number.isInteger(evidence.authDispatches) ||
          evidence.authDispatches < 0 ||
          evidence.authDispatches > 64
        )
          throw Error();
        console.log(JSON.stringify(evidence));
      } catch {
        console.error("FAIL: ISOLATION_FAILED");
        process.exitCode = 1;
      }
    }
    if (mode === "--check" && process.exitCode === 0)
      console.log(
        "PASS: offline compiled module graph loaded; no credentials or network accessed.",
      );
  } catch {
    console.error("FAIL: POOL_LIFECYCLE_FAILED");
    process.exitCode = 1;
  }
}
