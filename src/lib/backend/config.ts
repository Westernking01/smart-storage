export interface BackendConfig {
  url: string;
  key: string;
  origin: string;
  environment: "development" | "staging" | "production";
}
export function backendConfig(
  env: Record<string, string | undefined>,
): BackendConfig | null {
  if (env.SMART_STORAGE_BACKEND_ENABLED !== "true") return null;
  if (env.SMART_STORAGE_TRANSFERS_ENABLED === "true")
    throw Error("CLOUD_TRANSFERS_UNVALIDATED");
  const environment = env.SMART_STORAGE_ENV;
  if (!["development", "staging", "production"].includes(environment ?? ""))
    throw Error("BACKEND_CONFIGURATION_INVALID");
  const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  const origin = new URL(env.APP_ORIGIN ?? "");
  const local = (u: URL) => ["127.0.0.1", "localhost"].includes(u.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        environment === "development" &&
        local(url) &&
        url.protocol === "http:"
      )) ||
    url.hostname.includes("mdyiczsuddpqgjtfofgs") ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    (origin.protocol !== "https:" &&
      !(
        environment === "development" &&
        local(origin) &&
        origin.protocol === "http:"
      ))
  )
    throw Error("BACKEND_CONFIGURATION_INVALID");
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
  // Publishable keys or legacy anon JWT only. Service credentials are never accepted.
  if (!/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(key)) {
    try {
      const payload = JSON.parse(atob(key.split(".")[1]));
      if (key.split(".").length !== 3 || payload.role !== "anon") throw Error();
    } catch {
      throw Error("BACKEND_CONFIGURATION_INVALID");
    }
  }
  return {
    url: url.origin,
    key,
    origin: origin.origin,
    environment: environment as BackendConfig["environment"],
  };
}
export function safeNext(value: unknown): string {
  return typeof value === "string" &&
    /^\/(app(?:\/transfers|\/files\/[a-f0-9-]{36})?|account|update-password)$/.test(
      value,
    )
    ? value
    : "/app";
}
export function validMutationOrigin(
  headers: Headers,
  expected: string,
): boolean {
  return (
    headers.get("origin") === expected &&
    !["cross-site", "none"].includes(headers.get("sec-fetch-site") ?? "")
  );
}
