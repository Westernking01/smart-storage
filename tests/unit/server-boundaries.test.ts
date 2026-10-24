import { beforeEach, afterEach, it, expect, vi } from "vitest";
const mocked = vi.hoisted(() => ({
  factory: vi.fn(),
  jar: { getAll: vi.fn(() => []), set: vi.fn() },
  getUser: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocked.factory }));
vi.mock("next/headers", () => ({ cookies: async () => mocked.jar }));
import { serverSupabase, verifiedAccount } from "@/lib/supabase/server";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SMART_STORAGE_BACKEND_ENABLED", "true");
  vi.stubEnv("SMART_STORAGE_ENV", "development");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://sdk-fixture.example.invalid");
  vi.stubEnv(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "sb_publishable_abcdefghijklmnopqrstuv",
  );
  vi.stubEnv("APP_ORIGIN", "https://app.example.invalid");
  mocked.factory.mockReturnValue({ auth: { getUser: mocked.getUser } });
});
afterEach(() => vi.unstubAllEnvs());
it("uses publishable credentials and secure SSR cookies, persists writes or fails explicitly", async () => {
  await serverSupabase(true);
  const options = mocked.factory.mock.calls[0][2];
  expect(options.cookieOptions).toEqual({
    path: "/",
    sameSite: "lax",
    secure: true,
  });
  options.cookies.setAll([
    { name: "fixture-cookie", value: "fixture-value", options: { path: "/" } },
  ]);
  expect(mocked.jar.set).toHaveBeenCalledWith(
    "fixture-cookie",
    "fixture-value",
    { path: "/" },
  );
  mocked.jar.set.mockImplementationOnce(() => {
    throw Error("read only");
  });
  expect(() =>
    options.cookies.setAll([
      { name: "fixture-cookie", value: "fixture-value", options: {} },
    ]),
  ).toThrow("COOKIE_WRITE_FAILED");
});
it("verifies fresh user records and rejects revoked or anonymous sessions", async () => {
  mocked.getUser.mockResolvedValueOnce({
    data: { user: null },
    error: { code: "revoked" },
  });
  expect(await verifiedAccount()).toBeNull();
  mocked.getUser.mockResolvedValueOnce({
    data: {
      user: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        role: "authenticated",
        email_confirmed_at: "2026-01-01",
        is_anonymous: true,
      },
    },
    error: null,
  });
  expect(await verifiedAccount()).toBeNull();
});
it("does not even construct an SDK when backend connectivity is disabled", async () => {
  vi.stubEnv("SMART_STORAGE_BACKEND_ENABLED", "false");
  await expect(serverSupabase()).rejects.toThrow("BACKEND_DISABLED");
  expect(mocked.factory).not.toHaveBeenCalled();
});
