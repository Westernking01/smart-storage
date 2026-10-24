// Local executable launcher. Compiles nonsecret code using the installed compiler;
// no dependencies, credentials, environment files or network are loaded by build.
import ts from "typescript";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stdout.write(
    "Disabled. Use --check for offline compilation; execution requires --execute PLAN REVIEW AUTHORIZATION and interactive confirmation.\n",
  );
} else if (
  (args.length === 1 && args[0] === "--check") ||
  (args.length === 4 && args[0] === "--execute")
) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const outDir = resolve(root, ".cache/probe-auth-host");
  const program = ts.createProgram(
    [
      resolve(root, "experiments/storage/probe-auth-host-cli.ts"),
      resolve(root, "src/lib/gateway/seeded-fixture.server.ts"),
    ],
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
        "Offline host compilation passed. No authentication executed.\n",
      );
    else {
      const result = spawnSync(
        process.execPath,
        [
          "--conditions=react-server",
          resolve(outDir, "experiments/storage/probe-auth-host-cli.js"),
          ...args,
        ],
        { stdio: "inherit", shell: false },
      );
      process.exitCode = result.status ?? 1;
    }
  }
} else {
  process.stderr.write("Invalid arguments. Host remains disabled.\n");
  process.exitCode = 1;
}
