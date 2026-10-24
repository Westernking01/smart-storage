import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  backendConfig,
  safeNext,
  validMutationOrigin,
} from "@/lib/backend/config";
import { ordinaryIdentity } from "@/lib/backend/identity";
import { authInput, fileEdit, pageInput } from "@/lib/backend/schemas";
import { AuthLimiter } from "@/lib/backend/rate-limit";
import { boundedJson } from "@/lib/backend/http";
import { readCursor, nextCursor, ownedFile } from "@/lib/backend/files";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const good = {
  SMART_STORAGE_BACKEND_ENABLED: "true",
  SMART_STORAGE_ENV: "development",
  NEXT_PUBLIC_SUPABASE_URL: "https://unit-test.example.invalid",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abcdefghijklmnopqrstuv",
  APP_ORIGIN: "http://localhost:3000",
};
const mocked = vi.hoisted(() => ({
  client: {
    auth: {
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      signOut: vi.fn(),
      getUser: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updateUser: vi.fn(),
      exchangeCodeForSession: vi.fn(),
      verifyOtp: vi.fn(),
    },
    rpc: vi.fn(),
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  serverSupabase: vi.fn(async () => mocked.client),
  verifiedAccount: vi.fn(async () => {
    const result = await mocked.client.auth.getUser();
    return result.error
      ? null
      : { id: result.data.user?.id, client: mocked.client };
  }),
}));
import { POST as authPost } from "@/app/api/auth/[action]/route";
import { GET as callback } from "@/app/auth/callback/route";
import { PATCH as editFile } from "@/app/api/files/[id]/route";
import { currentAccount, listFiles } from "@/lib/backend/operations";
beforeEach(() => {
  vi.clearAllMocks();
  for (const [k, v] of Object.entries(good)) vi.stubEnv(k, v);
  mocked.client.auth.getUser.mockResolvedValue({
    data: {
      user: {
        id: A,
        role: "authenticated",
        is_anonymous: false,
        email_confirmed_at: "2026-01-01T00:00:00Z",
      },
    },
    error: null,
  });
  for (const name of [
    "signInWithPassword",
    "signUp",
    "signOut",
    "resetPasswordForEmail",
    "updateUser",
    "exchangeCodeForSession",
    "verifyOtp",
  ] as const)
    mocked.client.auth[name].mockResolvedValue({ data: {}, error: null });
});
async function auth(
  action: string,
  input: unknown,
  origin = "http://localhost:3000",
) {
  return authPost(
    new Request(`http://localhost:3000/api/auth/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin },
      body: JSON.stringify(input),
    }),
    { params: Promise.resolve({ action }) },
  );
}
describe("backend configuration and bounded contracts", () => {
  it("defaults to disabled regardless of existing credentials and rejects the stopped project", () => {
    expect(
      backendConfig({ ...good, SMART_STORAGE_BACKEND_ENABLED: undefined }),
    ).toBeNull();
    expect(() =>
      backendConfig({
        ...good,
        NEXT_PUBLIC_SUPABASE_URL: "https://mdyiczsuddpqgjtfofgs.supabase.co",
      }),
    ).toThrow();
    expect(() =>
      backendConfig({
        ...good,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_sensitive_test_value",
      }),
    ).toThrow();
    expect(() =>
      backendConfig({
        ...good,
        NEXT_PUBLIC_SUPABASE_URL: "https://user:secret@example.invalid",
      }),
    ).toThrow();
    expect(() =>
      backendConfig({
        ...good,
        APP_ORIGIN: "http://untrusted.example.invalid",
      }),
    ).toThrow();
    expect(backendConfig(good)?.environment).toBe("development");
  });
  it.each([
    "https://evil.invalid",
    "//evil.invalid",
    "/\\evil.invalid",
    "/%2f%2fevil.invalid",
    "/app?next=evil",
    "/app/../evil",
  ])("rejects redirect %j", (value) => expect(safeNext(value)).toBe("/app"));
  it("accepts only owned-app redirect paths and exact mutation origin", () => {
    expect(safeNext("/update-password")).toBe("/update-password");
    expect(
      validMutationOrigin(
        new Headers({ origin: "https://evil.invalid" }),
        good.APP_ORIGIN,
      ),
    ).toBe(false);
    expect(
      validMutationOrigin(
        new Headers({
          origin: good.APP_ORIGIN,
          "sec-fetch-site": "cross-site",
        }),
        good.APP_ORIGIN,
      ),
    ).toBe(false);
  });
  it("validates new passwords, edit metadata, pagination and rejects caller ownership", () => {
    expect(
      authInput.register.safeParse({ email: "bad", password: "tiny" }).success,
    ).toBe(false);
    expect(
      authInput.login.safeParse({
        email: "user@example.invalid",
        password: "valid",
        ownerId: A,
      }).success,
    ).toBe(false);
    expect(
      fileEdit.safeParse({
        displayName: "../evil",
        category: "other",
        revision: 1,
      }).success,
    ).toBe(false);
    expect(
      fileEdit.safeParse({
        displayName: "normal.bin",
        category: "other",
        revision: 1,
        ownerId: A,
      }).success,
    ).toBe(false);
    expect(pageInput.safeParse({ limit: 51 }).success).toBe(false);
    expect(() => readCursor("invalid")).toThrow();
    const file = ownedFile.parse({
      id: A,
      displayName: "test.bin",
      originalName: "test.bin",
      originalMime: null,
      category: "other",
      state: "ready",
      originalBytes: "10",
      encodedBytes: "10",
      manifestBytes: "500",
      storedBytes: "510",
      createdAt: "2026-10-13T00:00:00Z",
      revision: 1,
    });
    expect(readCursor(nextCursor(file))).toEqual({ at: file.createdAt, id: A });
  });
  it("accepts only freshly verified ordinary confirmed identity shapes", () => {
    const user = {
      id: A,
      role: "authenticated",
      email_confirmed_at: "2026-01-01",
      is_anonymous: false,
    };
    expect(ordinaryIdentity(user)).toBe(A);
    for (const delta of [
      { role: "service_role" },
      { is_anonymous: true },
      { email_confirmed_at: null },
      { id: "forged" },
    ])
      expect(ordinaryIdentity({ ...user, ...delta })).toBeNull();
  });
  it("bounds request bytes before JSON parsing and rate-limit map growth", async () => {
    await expect(
      boundedJson(
        new Request("http://localhost", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ large: "x".repeat(20000) }),
        }),
      ),
    ).rejects.toThrow("BODY_LIMIT");
    const limiter = new AuthLimiter();
    for (let i = 0; i < 8; i++)
      expect(limiter.allow("subject", 100)).toBe(true);
    expect(limiter.allow("subject", 100)).toBe(false);
    expect(limiter.allow("subject", 300101)).toBe(true);
  });
});
describe("Auth and owned operations with mocked SDK only", () => {
  it("performs login then fresh verification; never trusts submitted IDs or expired/revoked sessions", async () => {
    const response = await auth("login", {
      email: "login1@example.invalid",
      password: "fixture_password_123",
      next: "https://evil.invalid",
    });
    expect(response.status).toBe(200);
    expect((await response.json()).next).toBe("/app");
    mocked.client.auth.getUser.mockResolvedValueOnce({
      data: { user: null },
      error: { code: "bad_jwt" },
    });
    expect(
      (
        await auth("login", {
          email: "login2@example.invalid",
          password: "fixture_password_123",
        })
      ).status,
    ).toBe(401);
    expect(mocked.client.auth.signOut).toHaveBeenCalled();
    expect(
      (
        await auth("login", {
          email: "login3@example.invalid",
          password: "fixture_password_123",
          ownerId: A,
        })
      ).status,
    ).toBe(422);
  });
  it("never sends an Auth request while disabled or for a foreign origin", async () => {
    expect(
      (
        await auth(
          "login",
          { email: "origin@example.invalid", password: "fixture_password_123" },
          "https://evil.invalid",
        )
      ).status,
    ).toBe(403);
    vi.stubEnv("SMART_STORAGE_BACKEND_ENABLED", "false");
    expect(
      (
        await auth("login", {
          email: "disabled@example.invalid",
          password: "fixture_password_123",
        })
      ).status,
    ).toBe(503);
    expect(mocked.client.auth.signInWithPassword).not.toHaveBeenCalled();
  });
  it("reports recovery provider failures generically and password update requires fresh identity", async () => {
    const first = await (
      await auth("reset", { email: "present@example.invalid" })
    ).json();
    mocked.client.auth.resetPasswordForEmail.mockResolvedValueOnce({
      error: { code: "unknown_user" },
    });
    const failed = await auth("reset", { email: "missing@example.invalid" });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      error: { code: "RESET_REQUEST_FAILED", requestId: expect.any(String) },
    });
    expect(first).toEqual({
      message:
        "If this address can receive recovery mail, instructions will arrive shortly.",
    });
    mocked.client.auth.getUser.mockResolvedValueOnce({
      data: { user: null },
      error: { code: "session_revoked" },
    });
    expect(
      (await auth("update", { password: "new_fixture_password_123" })).status,
    ).toBe(401);
    expect(mocked.client.auth.updateUser).not.toHaveBeenCalled();
    expect(
      (await auth("update", { password: "new_fixture_password_123" })).status,
    ).toBe(200);
  });
  it("handles registration, callback verification and safe recovery destination", async () => {
    expect(
      (
        await auth("register", {
          email: "new@example.invalid",
          password: "new_fixture_password_123",
        })
      ).status,
    ).toBe(200);
    const good = await callback(
      new Request(
        "http://localhost:3000/auth/callback?code=fixture_code&next=https://evil.invalid",
      ),
    );
    expect(good.headers.get("location")).toBe("http://localhost:3000/app");
    const recovery = await callback(
      new Request(
        `http://localhost:3000/auth/callback?token_hash=${"a".repeat(64)}&type=recovery`,
      ),
    );
    expect(recovery.headers.get("location")).toBe(
      "http://localhost:3000/update-password",
    );
    const invalid = await callback(
      new Request(
        "http://localhost:3000/auth/callback?token_hash=invalid&type=admin",
      ),
    );
    expect(invalid.headers.get("location")).toContain(
      "/login?error=confirmation",
    );
  });
  it("rejects foreign resource edits and does not accept browser-selected owner fields", async () => {
    mocked.client.rpc.mockResolvedValue({
      data: null,
      error: { message: "NOT_FOUND" },
    });
    const request = new Request(`http://localhost:3000/api/files/${A}`, {
      method: "PATCH",
      headers: { origin: good.APP_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "renamed.bin",
        category: "other",
        revision: 1,
      }),
    });
    expect(
      (await editFile(request, { params: Promise.resolve({ id: A }) })).status,
    ).toBe(404);
    expect(mocked.client.rpc).toHaveBeenCalledWith("ss_edit_file", {
      p_id: A,
      p_name: "renamed.bin",
      p_category: "other",
      p_revision: 1,
    });
  });
  it("fails closed on a foreign account response or unready normal listing", async () => {
    const context = { id: A, client: mocked.client } as unknown as Parameters<
      typeof currentAccount
    >[0];
    mocked.client.rpc.mockResolvedValueOnce({
      data: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        needsBootstrap: true,
      },
      error: null,
    });
    await expect(currentAccount(context)).rejects.toThrow(
      "BACKEND_RESPONSE_INVALID",
    );
    mocked.client.rpc.mockResolvedValueOnce({
      data: [
        {
          id: A,
          displayName: "unfinished",
          originalName: "unfinished",
          originalMime: null,
          category: "other",
          state: "uploading",
          originalBytes: "10",
          encodedBytes: null,
          manifestBytes: null,
          storedBytes: null,
          createdAt: "2026-10-13T00:00:00Z",
          revision: 0,
        },
      ],
      error: null,
    });
    await expect(listFiles(context)).rejects.toThrow(
      "BACKEND_RESPONSE_INVALID",
    );
  });
});
