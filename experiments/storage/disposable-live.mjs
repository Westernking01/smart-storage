// --check compiles offline. --execute requires operator approval and hidden TTY confirmation.
import ts from "typescript";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const mode = process.argv[2];
if (
  process.argv.length !== 3 ||
  !["--check", "--preflight", "--execute"].includes(mode) ||
  process.env.NODE_OPTIONS ||
  process.execArgv.length
) {
  process.stderr.write(
    "BLOCKED: use --check, --preflight or separately approved --execute.\n",
  );
  process.exitCode = 1;
} else {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const outDir = resolve(root, ".cache/disposable-live-launcher");
  const program = ts.createProgram(
    [resolve(root, "experiments/storage/disposable-live-launcher-cli.ts")],
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
  if (ts.getPreEmitDiagnostics(program).length || program.emit().emitSkipped) {
    process.stderr.write("BLOCKED: offline compilation failed.\n");
    process.exitCode = 1;
  } else {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "package.json"), '{"type":"commonjs"}\n');
    if (mode === "--check")
      process.stdout.write("PASS: offline compilation only; no live login.\n");
    else {
      const result = spawnSync(
        process.execPath,
        [
          "--conditions=react-server",
          resolve(
            outDir,
            "experiments/storage/disposable-live-launcher-cli.js",
          ),
          mode,
        ],
        { stdio: "inherit", shell: false },
      );
      process.exitCode = result.status ?? 1;
    }
  }
}
