import { ordinarySessionBridge } from "./disposable-ordinary-session";

const origin = "https://rrylhvqalsxjnkdkpwde.supabase.co";
const endpoint = `${origin}/storage/v1/bucket/smart-storage-gateway-probe`;

/** Previously authorized diagnostic only. No claims, listing or object requests. */
export async function checkBucketMetadata(input: {
  hidden: (prompt: string) => Promise<string>;
  transport: typeof fetch;
}) {
  const result = {
    project: "rrylhvqalsxjnkdkpwde",
    expectedUserId: "310d0ec8-84ca-423a-b646-0480a20edc09",
    identityVerified: false,
    endpoint,
    method: "GET",
    observedAt: new Date().toISOString(),
    status: null as number | null,
    outcome: "BLOCKED" as "PASS" | "BLOCKED",
    reason: "AUTH_UNVERIFIED",
    requestHeaderNames: ["Authorization", "Accept-Encoding"],
    bucket: null as null | {
      id: string;
      name: string;
      public: boolean;
      file_size_limit: number;
      allowed_mime_types: null;
    },
  };
  try {
    const session = await ordinarySessionBridge({
      publicUrl: origin,
      publicKey: await input.hidden(
        "Disposable publishable/anon key (hidden): ",
      ),
      credentials: async () => ({
        email: await input.hidden("Dedicated test-user email (hidden): "),
        password: await input.hidden("Dedicated test-user password (hidden): "),
      }),
      transport: input.transport,
    })();
    result.identityVerified = true;
    result.reason = "STORAGE_UNCERTAIN";
    if (session.expiresAt <= Date.now()) return result;
    const response = await input.transport(endpoint, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Accept-Encoding": "identity",
      },
    });
    result.observedAt = new Date().toISOString();
    result.status = response.status;
    if (response.status !== 200) {
      await response.body?.cancel();
      result.reason = "HTTP_REJECTED";
      return result;
    }
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding !== "identity") {
      await response.body?.cancel();
      return result;
    }
    const reader = response.body?.getReader();
    if (!reader) return result;
    let text = "",
      size = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) throw Error("LIMIT");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel();
    }
    const bucket = JSON.parse(text);
    if (
      bucket?.id !== "smart-storage-gateway-probe" ||
      bucket.name !== "smart-storage-gateway-probe" ||
      bucket.public !== false ||
      bucket.file_size_limit !== 52428800 ||
      bucket.allowed_mime_types !== null
    ) {
      result.reason = "BUCKET_MISMATCH";
      return result;
    }
    // Copy only checked constants; never export arbitrary provider fields/errors.
    result.bucket = {
      id: bucket.id,
      name: bucket.name,
      public: false,
      file_size_limit: 52428800,
      allowed_mime_types: null,
    };
    result.outcome = "PASS";
    result.reason = "EXPECTED_PRIVATE_BUCKET_VERIFIED";
  } catch {
    // Credential errors and provider responses must never escape to logs.
  }
  return result;
}
