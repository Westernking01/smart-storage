import ts from "typescript";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (!args.length) {
  process.stdout.write(
    "Disabled. Use --check, or --dry-run/--execute PLAN REVIEW AUTH_APPROVAL CONFIG STORAGE_APPROVAL.\n",
  );
} else if (
  (args.length === 1 && args[0] === "--check") ||
  (args.length === 6 && ["--dry-run", "--execute"].includes(args[0]))
) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const outDir = resolve(root, ".cache/seeded-probe-host");
  const program = ts.createProgram(
    [resolve(root, "experiments/storage/seeded-probe-host-cli.ts")],
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
  if (diagnostics.length) {
    process.stderr.write(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => root,
        getCanonicalFileName: (v) => v,
        getNewLine: () => "\n",
      }),
    );
    process.exitCode = 1;
  } else {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "package.json"), '{"type":"commonjs"}\n');
    program.emit();
    if (args[0] === "--check")
      process.stdout.write(
        "PASS offline host compilation. No credentials, registration or network.\n",
      );
    else {
      const result = spawnSync(
        process.execPath,
        [
          "--conditions=react-server",
          resolve(outDir, "experiments/storage/seeded-probe-host-cli.js"),
          ...args,
        ],
        { stdio: "inherit", shell: false },
      );
      process.exitCode = result.status ?? 1;
    }
  }
} else {
  process.stderr.write("Invalid arguments. Host disabled.\n");
  process.exitCode = 1;
}
