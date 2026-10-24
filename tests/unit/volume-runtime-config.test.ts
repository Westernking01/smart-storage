import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { localVolumeEnabled } from "../../src/lib/gateway/volume-runtime.server";
const environment = {
  SMART_STORAGE_LOCAL_VOLUME_ENABLED: "true",
  SMART_STORAGE_BACKEND_ENABLED: "true",
  SMART_STORAGE_TRANSFERS_ENABLED: "false",
  SMART_STORAGE_ENV: "development",
  APP_ORIGIN: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_local_test_placeholder",
};
it("keeps local disk transfers opt-in without changing the cloud transfer gate", () => {
  expect(localVolumeEnabled({})).toBe(false);
  expect(localVolumeEnabled(environment)).toBe(true);
  expect(() =>
    localVolumeEnabled({
      ...environment,
      SMART_STORAGE_TRANSFERS_ENABLED: "true",
    }),
  ).toThrow("CLOUD_TRANSFERS_UNVALIDATED");
});
it("rejects production/staging and non-loopback application origins", () => {
  for (const change of [
    {
      SMART_STORAGE_ENV: "production",
      NEXT_PUBLIC_SUPABASE_URL: "https://local-auth.example.invalid",
      APP_ORIGIN: "https://localhost:3000",
    },
    {
      SMART_STORAGE_ENV: "staging",
      NEXT_PUBLIC_SUPABASE_URL: "https://local-auth.example.invalid",
      APP_ORIGIN: "https://localhost:3000",
    },
    { APP_ORIGIN: "https://app.example.invalid" },
  ])
    expect(() => localVolumeEnabled({ ...environment, ...change })).toThrow(
      "LOCAL_VOLUME_CONFIGURATION_INVALID",
    );
});
