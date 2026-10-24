import { maskedInput } from "./probe-auth-host-cli";
import { practiceRoundTrip } from "./practice-roundtrip-core";
if (require.main === module) {
  void (async () => {
    if (
      process.argv.length !== 3 ||
      process.argv[2] !== "--execute" ||
      process.env.NODE_OPTIONS ||
      process.execArgv.some((v) => /inspect|debug/.test(v)) ||
      !process.stdin.isTTY ||
      !process.stdout.isTTY
    )
      throw Error();
    const report = await practiceRoundTrip({
      hidden: maskedInput,
      transport: fetch,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.verified) process.exitCode = 1;
  })().catch(() => {
    process.stderr.write(
      "FAIL: private terminal required or cancelled. No automatic retry.\n",
    );
    process.exitCode = 1;
  });
}

