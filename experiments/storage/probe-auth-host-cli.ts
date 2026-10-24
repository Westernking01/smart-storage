import { readFile } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import {
  authenticateProbeHost,
  preflightProbeAuthHost,
} from "../../src/lib/gateway/probe-auth-host.server";

/** No echo or mask characters; never use readline's default echoed input. */
export type HiddenInputReason =
  | "UUID_MISMATCH"
  | "INPUT_CANCELLED"
  | "TERMINAL_EOF"
  | "RAW_MODE_INITIALIZATION_FAILED"
  | "INPUT_ERROR"
  | "INTERACTIVE_TERMINAL_REQUIRED";
export type ConfirmationStage =
  "execution-confirmation" | "auth-confirmation" | "registration-confirmation";
export class HiddenInputError extends Error {
  constructor(
    readonly reason: HiddenInputReason,
    readonly stage?: ConfirmationStage,
  ) {
    super(reason);
  }
}

export async function confirmHidden(
  prompt: string,
  expected: string,
  stage: ConfirmationStage,
  terminal = { input: stdin, output: stdout },
) {
  try {
    if ((await maskedInput(prompt, terminal)) !== expected)
      throw new HiddenInputError("UUID_MISMATCH");
    return true;
  } catch (error) {
    throw new HiddenInputError(
      error instanceof HiddenInputError ? error.reason : "INPUT_ERROR",
      stage,
    );
  }
}

export function maskedInput(
  prompt: string,
  terminal = { input: stdin, output: stdout },
): Promise<string> {
  const { input: stdin, output: stdout } = terminal;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function")
    return Promise.reject(
      new HiddenInputError("INTERACTIVE_TERMINAL_REQUIRED"),
    );
  return new Promise((resolve, reject) => {
    let value = "";
    const previousRaw = stdin.isRaw;
    const cleanup = () => {
      stdin.removeListener("data", data);
      stdin.removeListener("end", ended);
      stdin.removeListener("error", inputError);
      stdin.setRawMode(previousRaw);
      stdin.pause();
      stdout.write("\n");
    };
    const failed = (reason: HiddenInputReason) => {
      value = "";
      try {
        cleanup();
      } catch {
        reason = "INPUT_ERROR";
      }
      reject(new HiddenInputError(reason));
    };
    const ended = () => failed("TERMINAL_EOF");
    const inputError = () => failed("INPUT_ERROR");
    const data = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") {
          const result = value;
          value = "";
          try {
            cleanup();
          } catch {
            reject(new HiddenInputError("INPUT_ERROR"));
            return;
          }
          resolve(result);
          return;
        }
        if (
          character === "\u0003" ||
          character === "\u0004" ||
          character === "\u001b"
        ) {
          failed("INPUT_CANCELLED");
          return;
        }
        if (character === "\u007f" || character === "\b")
          value = value.slice(0, -1);
        else if (character >= " " && value.length < 2048) value += character;
        else {
          failed("INPUT_ERROR");
          return;
        }
      }
    };
    try {
      stdout.write(prompt);
    } catch {
      reject(new HiddenInputError("INPUT_ERROR"));
      return;
    }
    try {
      stdin.setRawMode(true);
    } catch {
      reject(new HiddenInputError("RAW_MODE_INITIALIZATION_FAILED"));
      return;
    }
    stdin.on("data", data).once("end", ended).once("error", inputError);
    try {
      stdin.resume();
    } catch {
      failed("INPUT_ERROR");
    }
  });
}

async function main() {
  // Files are nonsecret manifests only. Never accept credentials via args/env.
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--execute") throw Error("DISABLED");
  if (
    process.execArgv.some((v) => /inspect|debug/.test(v)) ||
    /inspect|debug/.test(process.env.NODE_OPTIONS ?? "")
  )
    throw Error("DEBUGGER_FORBIDDEN");
  const load = async (path: string) =>
    JSON.parse(
      (await readFile(path, "utf8")).replace(/^\uFEFF/, ""),
    ) as unknown;
  const plan = await load(args[1]);
  const review = await load(args[2]);
  const authorization = await load(args[3]);
  preflightProbeAuthHost(plan, review, authorization);
  const session = await authenticateProbeHost({
    plan,
    review,
    authorization,
    confirm: async (id) =>
      (await maskedInput(
        `Authorize one sign-in and one identity check: type ${id} (hidden): `,
      )) === id,
    readMaskedCredentials: async () => ({
      apiKey: await maskedInput("Disposable publishable key (hidden): "),
      email: await maskedInput("Dedicated user email (hidden): "),
      password: await maskedInput("Dedicated user password (hidden): "),
    }),
  });
  // This CLI validates Auth only. No Storage operation or credential export.
  try {
    stdout.write(
      "Dedicated identity verified. No Storage operation executed.\n",
    );
  } finally {
    session.dispose();
  }
}

// Never print exception objects, responses, request bodies, tokens or SDK errors.
if (require.main === module)
  void main().catch(() => {
    process.stderr.write(
      "Probe authentication disabled, cancelled or failed closed. No retry.\n",
    );
    process.exitCode = 1;
  });
