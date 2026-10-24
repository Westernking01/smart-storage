import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  BUCKET,
  PROJECT,
  TUS_BYTES,
  USERS,
  approve,
  validateIntent,
  boundResource,
  type Approval,
  type Intent,
} from "./manifest.js";
import {
  assertProject,
  safeError,
  type Response,
  type Transport,
} from "./runner.js";
import type { Ledger } from "./ledger.js";
import { parseProviderError } from "./denial.js";
import { assertContinuation } from "./continuation.js";
import { usableSession } from "./session.js";

export function publicConfiguration(path: string): {
  key: string;
  url: string;
} {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m =
      /^\s*(NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)\s*=\s*(.*?)\s*$/.exec(
        line,
      );
    if (m) values[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  const url = values.NEXT_PUBLIC_SUPABASE_URL;
  const key = values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key))
    throw new Error("PUBLISHABLE_KEY_REQUIRED");
  assertProject(url);
  return { url, key };
}
export class ProviderHttp implements Transport {
  constructor(
    private readonly key: string,
    private readonly ledger: Ledger,
    private readonly approval?: Approval,
    private readonly confirmation?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key))
      throw new Error("PUBLISHABLE_KEY_REQUIRED");
    approve(
      approval,
      confirmation,
      approval?.kind === "storage-provider-cleanup",
    );
  }
  async send(intent: Intent, token?: string): Promise<Response> {
    const authorization = approve(
      this.approval,
      this.confirmation,
      intent.purpose === "cleanup",
    );
    if (!authorization.purposes.includes(intent.purpose))
      throw new Error("PURPOSE_NOT_APPROVED");
    validateIntent(
      intent,
      this.ledger.cleanupPreview().map((x) => x.path),
    );
    this.ledger.assertReservation(intent);
    assertContinuation(this.ledger, authorization, intent, true);
    if (token) {
      let claims: { role?: string; sub?: string };
      try {
        claims = JSON.parse(
          Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
        );
      } catch {
        throw new Error("ORDINARY_AUTH_TOKEN_REQUIRED");
      }
      if (
        intent.actor === "anonymous" ||
        claims.role !== "authenticated" ||
        claims.sub !== USERS[intent.actor].id ||
        !usableSession(token, intent.actor)
      )
        throw new Error("ORDINARY_AUTH_TOKEN_REQUIRED");
    } else if (intent.actor !== "anonymous" && intent.purpose !== "login")
      throw new Error("ORDINARY_AUTH_TOKEN_REQUIRED");
    const authOrigin = `https://${PROJECT}.supabase.co`;
    const origin = `https://${PROJECT}.storage.supabase.co`;
    const headers: Record<string, string> = { apikey: this.key };
    if (token) headers.Authorization = `Bearer ${token}`;
    let url: string;
    if (intent.purpose === "login") {
      url = `${authOrigin}/auth/v1/token?grant_type=password`;
      headers["Content-Type"] = "application/json";
    } else if (intent.purpose === "identity")
      url = `${authOrigin}/auth/v1/user`;
    else if (intent.purpose === "tus-create") {
      url = `${origin}/storage/v1/upload/resumable`;
      headers["Tus-Resumable"] = "1.0.0";
      headers["Upload-Length"] = String(TUS_BYTES);
      headers["Upload-Metadata"] =
        `bucketName ${Buffer.from(BUCKET).toString("base64")},objectName ${Buffer.from(intent.path!).toString("base64")},contentType ${Buffer.from("application/octet-stream").toString("base64")}`;
    } else if (intent.purpose === "tus-head" || intent.purpose === "tus-part") {
      const r = intent.resource && this.ledger.state.resources[intent.resource];
      if (!r || r.path !== intent.path || r.actor !== intent.actor)
        throw new Error("RESOURCE_BINDING_REQUIRED");
      url = boundResource(r.url, r.path);
      headers["Tus-Resumable"] = "1.0.0";
      if (intent.purpose === "tus-part") {
        headers["Upload-Offset"] = String(intent.offset);
        headers["Content-Type"] = "application/offset+octet-stream";
      }
    } else {
      const path = intent.path!.split("/").map(encodeURIComponent).join("/");
      if (intent.purpose === "owner-info")
        url = `${origin}/storage/v1/object/info/authenticated/${BUCKET}/${path}`;
      else if (intent.method === "GET")
        url = `${origin}/storage/v1/object/authenticated/${BUCKET}/${path}`;
      else url = `${origin}/storage/v1/object/${BUCKET}/${path}`;
      if (intent.method === "POST") {
        headers["Content-Type"] = "application/octet-stream";
        headers["x-upsert"] = "false";
      }
    }
    // Exactly one fetch. Redirects/retries, signed endpoints, refresh and service keys are absent.
    approve(this.approval, this.confirmation, intent.purpose === "cleanup");
    if (
      token &&
      intent.actor !== "anonymous" &&
      !usableSession(token, intent.actor)
    )
      throw new Error("SESSION_EXPIRED_RENEWAL_REQUIRED");
    const response = await this.fetcher(url, {
      method: intent.method,
      headers,
      body: intent.body ? Buffer.from(intent.body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const result: Response = { status: response.status };
    try {
      const numberHeader = (name: string) => {
        const value = response.headers.get(name);
        if (value === null) return undefined;
        if (
          !/^(0|[1-9][0-9]*)$/.test(value) ||
          !Number.isSafeInteger(Number(value))
        )
          throw new Error("INVALID_OFFSET_HEADER");
        return Number(value);
      };
      result.offset = numberHeader("upload-offset");
      result.length = numberHeader("upload-length");
      if (intent.purpose === "tus-create")
        result.location = response.headers.get("location") ?? undefined;
      const jsonResponse = ["login", "identity", "owner-info"].includes(
        intent.purpose,
      );
      const limit = jsonResponse
        ? 65_536
        : intent.purpose === "download"
          ? 256
          : 16_384;
      let size = 0;
      const digest = createHash("sha256");
      const chunks: Uint8Array[] = [];
      if (response.body)
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.byteLength;
          if (size > limit) throw new Error("RESPONSE_BODY_LIMIT");
          digest.update(chunk);
          if ((jsonResponse && response.ok) || !response.ok) chunks.push(chunk);
        }
      result.responseBytes = size;
      result.digest = digest.digest("hex");
      if (!response.ok) {
        try {
          result.providerError = parseProviderError(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          );
        } catch {
          /* Invalid error bodies never establish the special 400 denial. */
        }
      }
      if (jsonResponse && response.ok) {
        try {
          result.json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new Error("INVALID_PROVIDER_JSON");
        }
      }
    } catch (error) {
      result.errorCode = safeError(error);
    }
    return result;
  }
}
