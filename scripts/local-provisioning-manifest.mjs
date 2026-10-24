// --check is offline; --execute requires separate authorization and a private TTY.
import ts from "typescript";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const mode = process.argv[2];
if (
  process.argv.length !== 3 ||
  !["--check", "--execute", "--login"].includes(mode) ||
  process.env.NODE_OPTIONS ||
  process.execArgv.length
) {
  console.error(
    "BLOCKED: use --check, --execute or --login in a private terminal.",
  );
  process.exitCode = 1;
} else {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const outDir = resolve(root, ".cache/local-provisioning-manifest");
  const program = ts.createProgram(
    [resolve(root, "scripts/local-provisioning-manifest-cli.ts")],
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      rootDir: root,
      outDir,
      noEmitOnError: true,
    },
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length || program.emit().emitSkipped) {
    console.error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => root,
        getNewLine: () => "\n",
      }),
    );
    process.exitCode = 1;
  } else {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "package.json"), '{"type":"commonjs"}\n');
    if (mode === "--check")
      console.log("PASS: offline compilation only; no Auth or SQL requests.");
    else
      process.exitCode =
        spawnSync(
          process.execPath,
          [
            "--conditions=react-server",
            resolve(outDir, "scripts/local-provisioning-manifest-cli.js"),
            mode,
          ],
          { stdio: "inherit", shell: false },
        ).status ?? 1;
  }
}
