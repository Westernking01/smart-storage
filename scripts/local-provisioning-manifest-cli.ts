import { maskedInput } from "../experiments/storage/probe-auth-host-cli";
import {
  privateManifestVerifier,
  privateLoginManifestVerifier,
} from "./local-provisioning-manifest-core";

if (require.main === module) {
  void (async () => {
    if (
      process.argv.length !== 3 ||
      !["--execute", "--login"].includes(process.argv[2]) ||
      process.execArgv.some((v) => /inspect|debug/.test(v)) ||
      process.env.NODE_OPTIONS ||
      !process.stdin.isTTY ||
      !process.stdout.isTTY
    )
      throw Error();
    const login = process.argv[2] === "--login";
    if (
      (await maskedInput(
        login
          ? "ONE password sign-in + ONE getUser on fneuqneqaopkmpeevlqz; no allocation. Type LOGIN AND VERIFY LOCAL MANIFEST (hidden): "
          : "ONE Auth getUser on fneuqneqaopkmpeevlqz; no login or allocation. Type VERIFY LOCAL MANIFEST (hidden): ",
      )) !==
      (login ? "LOGIN AND VERIFY LOCAL MANIFEST" : "VERIFY LOCAL MANIFEST")
    )
      throw Error();
    let key = await maskedInput("Development publishable/anon key (hidden): ");
    let bearer = "",
      email = "",
      password = "";
    try {
      let manifest;
      if (login) {
        email = await maskedInput("Existing ordinary account email (hidden): ");
        password = await maskedInput(
          "Existing ordinary account password (hidden): ",
        );
        manifest = await privateLoginManifestVerifier(fetch)(
          key,
          email,
          password,
        );
      } else {
        bearer = await maskedInput(
          "Current ordinary account access token (hidden; no password/refresh token): ",
        );
        manifest = await privateManifestVerifier(fetch)(key, bearer);
      }
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      process.stdout.write(
        "Verified now; review only. No account allocated. Reverify if stale.\n",
      );
    } finally {
      key = "";
      bearer = "";
      email = "";
      password = "";
    }
  })().catch(() => {
    process.stderr.write(
      "BLOCKED: cancelled or unverified. No automatic retry; no manifest approved.\n",
    );
    process.exitCode = 1;
  });
}
