import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocked = vi.hoisted(() => ({
  factory: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocked.factory }));
import { proxy } from "@/proxy";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SMART_STORAGE_BACKEND_ENABLED", "true");
  vi.stubEnv("SMART_STORAGE_TRANSFERS_ENABLED", "false");
  vi.stubEnv("SMART_STORAGE_ENV", "development");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture-project.supabase.co");
  vi.stubEnv(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "sb_publishable_abcdefghijklmnopqrstuv",
  );
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  mocked.factory.mockReturnValue({ auth: { getUser: mocked.getUser } });
});
afterEach(() => vi.unstubAllEnvs());

it("passes request cookies to verified identity lookup and preserves refresh writes", async () => {
  mocked.getUser.mockResolvedValue({
    data: {
      user: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        role: "authenticated",
        email_confirmed_at: "2026-01-01T00:00:00Z",
        is_anonymous: false,
      },
    },
    error: null,
  });
  const request = new NextRequest("http://localhost:3000/account", {
    headers: { cookie: "sb-fixture-project-auth-token=fixture" },
  });
  const result = await proxy(request);
  const options = mocked.factory.mock.calls[0][2];
  expect(options.cookies.getAll()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "sb-fixture-project-auth-token",
        value: "fixture",
      }),
    ]),
  );
  options.cookies.setAll([
    {
      name: "sb-fixture-project-auth-token",
      value: "refreshed",
      options: { path: "/", sameSite: "lax" },
    },
  ]);
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
});

it("redirects a missing or invalid session using a bounded same-origin next value", async () => {
  mocked.getUser.mockResolvedValue({ data: { user: null }, error: {} });
  const result = await proxy(
    new NextRequest("http://localhost:3000/app/files/not-a-uuid"),
  );
  expect(result.status).toBe(307);
  const destination = new URL(result.headers.get("location")!);
  expect(destination.origin).toBe("http://localhost:3000");
  expect(destination.pathname).toBe("/login");
  expect(destination.searchParams.get("next")).toBe("/app/files/not-a-uuid");
});

it.each(["/forgot-password", "/api/auth/reset"])(
  "does not perform an unrelated session lookup for %s",
  async (pathname) => {
    const result = await proxy(
      new NextRequest(`http://localhost:3000${pathname}`),
    );
    expect(result.status).toBe(200);
    expect(mocked.factory).not.toHaveBeenCalled();
    expect(mocked.getUser).not.toHaveBeenCalled();
  },
);
