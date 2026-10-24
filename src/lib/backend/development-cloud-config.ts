import "server-only";
import { backendConfig } from "./config";

export function developmentCloudConfig(
  env: Record<string, string | undefined>,
) {
  if (env.SMART_STORAGE_DEV_CLOUD_ENABLED !== "true") return null;
  const backend = backendConfig(env);
  const project = env.SMART_STORAGE_DEV_CLOUD_PROJECT_REF ?? "";
  const bucket = env.SMART_STORAGE_DEV_CLOUD_BUCKET ?? "";
  const permitKey = env.SMART_STORAGE_DEV_CLOUD_PERMIT_KEY ?? "";
  if (
    !backend ||
    backend.environment !== "development" ||
    env.SMART_STORAGE_TRANSFERS_ENABLED !== "false" ||
    !["localhost", "127.0.0.1"].includes(new URL(backend.origin).hostname) ||
    !/^[a-z0-9]{20}$/.test(project) ||
    backend.url !== `https://${project}.supabase.co` ||
    !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(bucket) ||
    !/^[a-f0-9]{64}$/.test(permitKey)
  )
    throw Error("DEV_CLOUD_CONFIGURATION_INVALID");
  return {
    ...backend,
    project,
    bucket,
    permitKey,
    maximumBytes: 6 * 1024 * 1024,
  };
}
