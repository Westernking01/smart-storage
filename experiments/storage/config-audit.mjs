import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";

export function readConfiguration(path = ".env.local") {
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    values[match[1]] = value;
  }
  return values;
}

function role(value) {
  try {
    return JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString())
      .role;
  } catch {
    return null;
  }
}

export function audit() {
  const actual = readConfiguration();
  const example = readConfiguration(".env.example");
  const names = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  let urlValid = false;
  try {
    const url = new URL(actual[names[0]]);
    urlValid =
      url.protocol === "https:" &&
      /^[a-z0-9]+\.supabase\.co$/.test(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash;
  } catch {
    /* Report booleans only. */
  }
  const publicKey = actual[names[1]] || "";
  const service = actual[names[2]] || "";
  const publicValid =
    /^sb_publishable_[A-Za-z0-9_-]+$/.test(publicKey) ||
    role(publicKey) === "anon";
  const serviceValid =
    /^sb_secret_[A-Za-z0-9_-]+$/.test(service) ||
    role(service) === "service_role";
  const sensitive = Object.values(actual).filter((value) => value.length > 20);
  const skip = new Set([
    "node_modules",
    ".next",
    ".cache",
    ".git",
    "test-results",
    "playwright-report",
  ]);
  const exposedFiles = [];
  const serviceReferences = [];
  const clientBundleExposure = [];
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skip.has(entry.name) || entry.name === ".env.local") continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (
        /\.(?:[cm]?[jt]sx?|json|md|sql|html|css|local|example)$/.test(
          entry.name,
        ) &&
        statSync(path).size < 4 * 1024 * 1024
      ) {
        const content = readFileSync(path, "utf8");
        if (
          sensitive.some((value) => content.includes(value)) ||
          /sb_secret_[A-Za-z0-9_-]{15,}/.test(content)
        )
          exposedFiles.push(relative(process.cwd(), path));
        if (
          relative(process.cwd(), path).startsWith("src") &&
          /SUPABASE_SERVICE_ROLE_KEY|sb_secret_/.test(content)
        )
          serviceReferences.push(relative(process.cwd(), path));
      }
    }
  }
  scan(process.cwd());
  function scanClient(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) scanClient(path);
      else if (/\.(js|map|json)$/.test(entry.name)) {
        const content = readFileSync(path, "utf8");
        if (
          (service && content.includes(service)) ||
          /sb_secret_[A-Za-z0-9_-]{15,}/.test(content) ||
          content.includes("SUPABASE_SERVICE_ROLE_KEY")
        )
          clientBundleExposure.push(relative(process.cwd(), path));
      }
    }
  }
  scanClient(".next/static");
  const exampleOnlyPlaceholders =
    names.every((name) => /replace|your-project/.test(example[name] || "")) &&
    !Object.values(example).some(
      (value) => /^sb_(?:secret|publishable)_/.test(value) || role(value),
    );
  const publicHasPrivilegedValue = Object.entries(actual).some(
    ([name, value]) =>
      name.startsWith("NEXT_PUBLIC_") &&
      (value.startsWith("sb_secret_") || role(value) === "service_role"),
  );
  const ignore = existsSync(".gitignore")
    ? readFileSync(".gitignore", "utf8")
    : "";
  return {
    localExists: existsSync(".env.local"),
    exampleExists: existsSync(".env.example"),
    variables: names.map((name, index) => ({
      name,
      present: Boolean(actual[name]),
      formatValid: [urlValid, publicValid, serviceValid][index],
    })),
    exampleOnlyPlaceholders,
    envIgnoreRulePresent: /^\.env\*\s*$/m.test(ignore),
    publicHasPrivilegedValue,
    exposedFiles,
    serviceReferences,
    clientBundleExposure,
    gitRepositoryPresent: existsSync(".git"),
    formatChecksAreNotCredentialAuthentication: true,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve("experiments/storage/config-audit.mjs")
) {
  try {
    const result = audit();
    console.log(JSON.stringify(result, null, 2));
    if (
      result.exposedFiles.length ||
      result.serviceReferences.length ||
      result.clientBundleExposure.length ||
      result.publicHasPrivilegedValue
    )
      process.exitCode = 2;
  } catch {
    console.error(
      "Configuration audit failed; details suppressed to protect credentials",
    );
    process.exitCode = 1;
  }
}
