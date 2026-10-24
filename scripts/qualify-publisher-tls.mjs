// --check is offline; --execute requires separate hosted authorization.
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
  const out = new URL(
    "../.cache/publisher-tls-qualification/",
    import.meta.url,
  );
  mkdirSync(out, { recursive: true });
  const compile = (source) =>
    ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText;
  writeFileSync(
    new URL("adapter.mjs", out),
    compile(
      readFileSync(
        new URL(
          "../src/lib/backend/development-publisher-postgres.server.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
  const source = readFileSync(
    new URL("publisher-tls-qualification.ts", import.meta.url),
    "utf8",
  )
    .replace(
      '"../src/lib/backend/development-publisher-postgres.server"',
      '"./adapter.mjs"',
    )
    .replace(
      'new URL("../supabase/development-cloud/", import.meta.url)',
      `new URL(${JSON.stringify(new URL("../supabase/development-cloud/", import.meta.url).href)})`,
    );
  writeFileSync(new URL("runner.mjs", out), compile(source));
  if (mode === "--check")
    console.log(
      "PASS: offline transpilation only; no connection or credential access.",
    );
  else
    process.exitCode =
      spawnSync(
        process.execPath,
        [
          "--conditions=react-server",
          fileURLToPath(new URL("runner.mjs", out)),
          "--execute",
        ],
        { stdio: "inherit", shell: false },
      ).status ?? 1;
}
