import { digest, transform } from "../../src/lib/transfers/codec";
import {
  prepareDisposableFixture,
  disposableSupabaseAdapter,
} from "./disposable-roundtrip-executor";
import { ordinarySessionBridge } from "./disposable-ordinary-session";
import { postgresAttemptClaims } from "./disposable-postgres-claims";
import { disposableUploadTarget as t } from "./disposable-upload-contract";
import { request } from "node:https";

export async function practiceRoundTrip(input: {
  hidden: (prompt: string) => Promise<string>;
  transport: typeof fetch;
  nativeRequest?: typeof request;
}) {
  const report = {
    outcome: "FAIL",
    practiceOnly: true,
    project: t.project,
    bucket: t.bucket,
    key: t.key,
    sourceBytes: 0,
    encodedBytes: 0,
    downloadedBytes: 0,
    restoredBytes: 0,
    sourceSha256: "",
    encodedSha256: "",
    downloadedSha256: "",
    restoredSha256: "",
    http: [] as { operation: string; status: number }[],
    verified: false,
    stage: "confirmation",
    stop: "No retry, overwrite, deletion or cleanup. Retain all claims and objects.",
  };
  try {
    if (
      (await input.hidden(
        "Separate practice authorization: type AUTHORIZE ONE PRACTICE ROUNDTRIP (hidden): ",
      )) !== "AUTHORIZE ONE PRACTICE ROUNDTRIP"
    )
      throw Error();
    report.stage = "fixture";
    const f = await prepareDisposableFixture();
    Object.assign(report, {
      sourceBytes: f.sourceBytes,
      encodedBytes: f.encodedBytes,
      sourceSha256: f.sourceSha256,
      encodedSha256: f.encodedSha256,
    });
    if (
      f.sourceBytes !== 4736 ||
      f.encodedBytes !== 89 ||
      f.sourceSha256 !==
        "34886abb99160fae6c1180596deec9e9750025a4a55bba7134d027d2c6ebb9ec" ||
      f.encodedSha256 !==
        "fea29b705cfc93292be9a29f855a2e534ec13fe154dabe6b657234fc516094f7"
    )
      throw Error();
    const publicKey = await input.hidden(
      "Disposable publishable/anon key (hidden): ",
    );
    const observed: typeof fetch = async (url, init) => {
      const response = await input.transport(url, init);
      report.http.push({
        operation: String(url).includes("/auth/v1/user")
          ? "identity"
          : String(url).includes("/auth/")
            ? "login"
            : String(url).includes("/rpc/")
              ? `claim-${JSON.parse(String(init?.body)).p_operation}`
              : "absence-list",
        status: response.status,
      });
      return response;
    };
    report.stage = "authentication";
    const session = await ordinarySessionBridge({
      publicUrl: `https://${t.project}.supabase.co`,
      publicKey,
      credentials: async () => ({
        email: await input.hidden("Dedicated ordinary user email (hidden): "),
        password: await input.hidden("Password (hidden): "),
      }),
      transport: observed,
    })();
    report.stage = "authoritative-absence";
    // SQL is read by the operator in the confirmed project, never through privileged HTTP.
    const started = Date.now();
    if (
      (await input.hidden(
        "NOW run experiments/storage/practice-absence.readonly.sql in the confirmed rrylhvqalsxjnkdkpwde Dashboard. Only if object_exists=false AND claim_exists=false, and no earlier uncertain attempt: type FRESH KEY AND CLAIM ABSENT (hidden): ",
      )) !== "FRESH KEY AND CLAIM ABSENT"
    )
      throw Error();
    const expires = started + 120000;
    const check = () => {
      if (Date.now() >= expires || Date.now() >= session.expiresAt)
        throw Error();
    };
    check();
    report.stage = "ordinary-absence";
    const r = await observed(`${t.endpoint}/object/list/${t.bucket}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
        "Accept-Encoding": "identity",
      },
      body: JSON.stringify({
        prefix: "practice-roundtrip/20261019",
        search: "compressed-test-001.bin",
        limit: 2,
        offset: 0,
      }),
    });
    if (
      r.status !== 200 ||
      (r.headers.get("content-encoding") &&
        r.headers.get("content-encoding") !== "identity")
    ) {
      await r.body?.cancel();
      throw Error();
    }
    const reader = r.body?.getReader();
    if (!reader) throw Error();
    let body = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (body.length + value.length > 4096) throw Error();
        body += new TextDecoder("utf-8", { fatal: true }).decode(value);
      }
    } finally {
      await reader.cancel();
    }
    const entries = JSON.parse(body);
    if (!Array.isArray(entries) || entries.length !== 0) throw Error();
    const claim = postgresAttemptClaims({
      session,
      publicKey,
      transport: observed,
      check,
    });
    const native = input.nativeRequest ?? request;
    const tracked = ((...args: Parameters<typeof request>) => {
      // Preserve the existing adapter's byte limits, no redirects and create-only headers.
      const callback = args[2] as (
        res: import("node:http").IncomingMessage,
      ) => void;
      args[2] = (res: import("node:http").IncomingMessage) => {
        report.http.push({
          operation: report.stage,
          status: res.statusCode ?? 0,
        });
        callback(res);
      };
      return native(...args);
    }) as typeof request;
    const provider = disposableSupabaseAdapter(tracked);
    const prefix = `${t.project}/${t.bucket}/${t.key}/`;
    report.stage = "upload-claim";
    if (!(await claim(`${prefix}upload`))) throw Error();
    check();
    report.stage = "upload";
    await provider.create(f.encoded, session);
    check();
    report.stage = "download-claim";
    if (!(await claim(`${prefix}download`))) throw Error();
    check();
    report.stage = "download";
    const bytes = await provider.download(session);
    report.downloadedBytes = bytes.length;
    report.downloadedSha256 = digest(bytes);
    report.stage = "integrity";
    if (bytes.length !== f.encodedBytes || digest(bytes) !== f.encodedSha256)
      throw Error();
    const restored = await transform(bytes, "decode", f.sourceBytes);
    report.restoredBytes = restored.length;
    report.restoredSha256 = digest(restored);
    if (
      restored.length !== f.sourceBytes ||
      digest(restored) !== f.sourceSha256 ||
      !restored.every((b, i) => b === f.source[i])
    )
      throw Error();
    report.verified = true;
    report.outcome = "PASS";
    report.stage = "complete";
  } catch {
    /* Only allowlisted fields leave this function. */
  }
  return report;
}
