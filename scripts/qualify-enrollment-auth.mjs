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
  console.error(
    "FAIL: use --check or separately authorized --execute without Node overrides.",
  );
  process.exitCode = 1;
} else {
  try {
    const out = new URL(
      "../.cache/enrollment-auth-qualification/",
      import.meta.url,
    );
    mkdirSync(out, { recursive: true });
    const modules = {
      runner: "scripts/enrollment-auth-qualification.ts",
      tls: "scripts/publisher-tls-qualification.ts",
      adapter: "src/lib/backend/development-publisher-postgres.server.ts",
      verifier: "src/lib/backend/development-user-verifier.server.ts",
      identity: "src/lib/backend/identity.ts",
    };
    const replacements = {
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
        mode === "--execute" ? "--enrollment-execute" : "--check",
      ],
      { stdio: "inherit", shell: false },
    );
    process.exitCode = result.status ?? 1;
    if (mode === "--check" && process.exitCode === 0)
      console.log(
        "PASS: offline compiled module graph loaded; no credentials or network accessed.",
      );
  } catch {
    console.error("FAIL: enrollment qualification preparation.");
    process.exitCode = 1;
  }
}
