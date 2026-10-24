// Offline launcher only. Live use requires a separately reviewed, private
// in-process operator bridge to runOperatorRoundTrip; no session is loaded here.
import ts from "typescript";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

if (process.argv.length !== 3 || process.argv[2] !== "--check") {
  process.stderr.write(
    "Disabled. Only --check (offline compilation) is available.\n",
  );
  process.exitCode = 1;
} else {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const outDir = resolve(root, ".cache/disposable-roundtrip-host");
  const program = ts.createProgram(
    [resolve(root, "experiments/storage/disposable-roundtrip-host.ts")],
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
    process.stdout.write(
      "Offline compilation PASS. No session, claims or network accessed.\n",
    );
  }
}
