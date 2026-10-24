import { maskedInput } from "./probe-auth-host-cli";
import { ordinarySessionBridge } from "./disposable-ordinary-session";
import { checkBucketMetadata } from "./disposable-metadata-check";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function checkOrdinaryAuthentication(input: {
  hidden: (prompt: string) => Promise<string>;
  transport: typeof fetch;
}): Promise<void> {
  if (
    (await input.hidden(
      "Authorize ONE login + ONE Auth identity check for rrylhvqalsxjnkdkpwde only. Type VERIFY DISPOSABLE AUTH (hidden): ",
    )) !== "VERIFY DISPOSABLE AUTH"
  )
    throw Error("CONFIRMATION_REQUIRED");
  const bridge = ordinarySessionBridge({
    publicUrl: "https://rrylhvqalsxjnkdkpwde.supabase.co",
    publicKey: await input.hidden("Disposable publishable/anon key (hidden): "),
    credentials: async () => ({
      email: await input.hidden("Dedicated test-user email (hidden): "),
      password: await input.hidden("Dedicated test-user password (hidden): "),
    }),
    transport: input.transport,
  });
  // Deliberately discard the verified bearer; never call the round-trip host.
  await bridge();
}

if (require.main === module) {
  void (async () => {
    if (
      process.argv.length !== 3 ||
      !["--execute", "--metadata"].includes(process.argv[2]) ||
      process.execArgv.some((v) => /inspect|debug/.test(v)) ||
      process.env.NODE_OPTIONS ||
      !process.stdin.isTTY ||
      !process.stdout.isTTY
    )
      throw Error("PRIVATE_INTERACTIVE_TERMINAL_REQUIRED");
    if (process.argv[2] === "--metadata") {
      const result = await checkBucketMetadata({
        hidden: maskedInput,
        transport: fetch,
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      // Compiled CLI lives under .cache/disposable-auth-check/experiments/storage.
      // Only the allowlisted result is persisted, outside the repository.
      const evidencePath = resolve(
        __dirname,
        "../../../../../smart-storage-strict-qualification-20261020",
        `metadata-http-${Date.now()}.json`,
      );
      await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, {
        flag: "wx",
      });
      process.stdout.write(`Sanitized evidence: ${evidencePath}\n`);
      if (result.outcome !== "PASS") process.exitCode = 1;
      return;
    }
    await checkOrdinaryAuthentication({
      hidden: maskedInput,
      transport: fetch,
    });
    process.stdout.write(
      "PASS: expected ordinary authenticated UUID verified by Supabase Auth; public key only. No Storage requests. Session discarded.\n",
    );
  })().catch(() => {
    process.stderr.write(
      "BLOCKED: authentication cancelled, rejected or unverified. Stop; no automatic retry.\n",
    );
    process.exitCode = 1;
  });
}
