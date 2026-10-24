import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../../src/lib/supabase/server", () => ({ serverSupabase: vi.fn() }));
import {
  privateManifestVerifier,
  privateLoginManifestVerifier,
} from "../../scripts/local-provisioning-manifest-core";
const issuer = "https://fneuqneqaopkmpeevlqz.supabase.co/auth/v1";
const subject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const key = "sb_publishable_fixturepublickey12345";
const user = {
  id: subject,
  role: "authenticated",
  email_confirmed_at: "2026-01-01T00:00:00Z",
  is_anonymous: false,
};
function token(overrides = {}) {
  return `e30.${Buffer.from(JSON.stringify({ sub: subject, iss: issuer, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 600, ...overrides })).toString("base64url")}.signature`;
}
it("uses exactly one fixed GET with bearer and emits only the allocation manifest", async () => {
  const bearer = token();
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(`${issuer}/user`);
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${bearer}`,
    );
    return new Response(JSON.stringify(user), { status: 200 });
  });
  const verify = privateManifestVerifier(transport);
  expect(await verify(key, bearer)).toEqual({
    issuer,
    subject,
    quotaBytes: "262144",
    maxSlots: 1,
  });
  await expect(verify(key, bearer)).rejects.toThrow("ALREADY_ATTEMPTED");
  expect(transport).toHaveBeenCalledTimes(1);
});
it("denies wrong issuer, privileged key/role and expired tokens before dispatch", async () => {
  const transport = vi.fn<typeof fetch>();
  for (const claims of [
    { iss: "https://wrong.invalid/auth/v1" },
    { role: "service_role" },
    { exp: 1 },
  ]) {
    await expect(
      privateManifestVerifier(transport)(key, token(claims)),
    ).rejects.toThrow("PRIVATE_IDENTITY_VERIFICATION_FAILED");
  }
  await expect(
    privateManifestVerifier(transport)("service-role-secret", token()),
  ).rejects.toThrow("PRIVATE_IDENTITY_VERIFICATION_FAILED");
  expect(transport).not.toHaveBeenCalled();
});
it("rejects unconfirmed, anonymous, privileged or mismatched remotely returned users", async () => {
  for (const invalid of [
    { ...user, email_confirmed_at: null },
    { ...user, is_anonymous: true },
    { ...user, role: "service_role" },
    { ...user, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  ]) {
    const transport = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(invalid)),
    );
    await expect(
      privateManifestVerifier(transport)(key, token()),
    ).rejects.toThrow("PRIVATE_IDENTITY_VERIFICATION_FAILED");
    expect(transport).toHaveBeenCalledTimes(1);
  }
});
it("redacts provider/transport failures and never dispatches a retry", async () => {
  for (const failure of ["throw", "503", "redirect"]) {
    const transport = vi.fn<typeof fetch>(async () => {
      if (failure === "throw") throw Error("private-token-and-password");
      return new Response("private-provider-body", {
        status: failure === "503" ? 503 : 302,
      });
    });
    await expect(
      privateManifestVerifier(transport)(key, token()),
    ).rejects.toThrow(/^PRIVATE_IDENTITY_VERIFICATION_FAILED$/);
    expect(transport).toHaveBeenCalledTimes(1);
  }
});

it("passes the in-memory sign-in token straight to one getUser and emits no secrets", async () => {
  const bearer = token();
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.redirect).toBe("error");
    if (String(url) === `${issuer}/token?grant_type=password`) {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        email: "fixture@example.invalid",
        password: "private-password",
      });
      return new Response(
        JSON.stringify({
          access_token: bearer,
          refresh_token: "private-refresh",
          token_type: "bearer",
          expires_in: 600,
          user,
        }),
      );
    }
    expect(String(url)).toBe(`${issuer}/user`);
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${bearer}`,
    );
    return new Response(JSON.stringify(user));
  });
  const verify = privateLoginManifestVerifier(transport);
  const manifest = await verify(
    key,
    "fixture@example.invalid",
    "private-password",
  );
  expect(manifest).toEqual({
    issuer,
    subject,
    quotaBytes: "262144",
    maxSlots: 1,
  });
  expect(JSON.stringify(manifest)).not.toMatch(
    /password|refresh|access_token|email/,
  );
  await expect(
    verify(key, "fixture@example.invalid", "private-password"),
  ).rejects.toThrow("LOGIN_ALREADY_ATTEMPTED");
  expect(transport).toHaveBeenCalledTimes(2);
});

it("stops after failed sign-in without getUser or automatic retry and redacts errors", async () => {
  for (const status of [401, 503, 302]) {
    const transport = vi.fn<typeof fetch>(
      async () => new Response("private-provider-error", { status }),
    );
    await expect(
      privateLoginManifestVerifier(transport)(
        key,
        "fixture@example.invalid",
        "private-password",
      ),
    ).rejects.toThrow(/^PRIVATE_LOGIN_VERIFICATION_FAILED$/);
    expect(transport).toHaveBeenCalledTimes(1);
  }
  const transport = vi.fn<typeof fetch>();
  await expect(
    privateLoginManifestVerifier(transport)(key, "", ""),
  ).rejects.toThrow("PRIVATE_LOGIN_VERIFICATION_FAILED");
  await expect(
    privateLoginManifestVerifier(transport)(
      "service-secret",
      "fixture@example.invalid",
      "private-password",
    ),
  ).rejects.toThrow("PRIVATE_LOGIN_VERIFICATION_FAILED");
  expect(transport).not.toHaveBeenCalled();
});

it("rejects a login token for the wrong project before getUser", async () => {
  const transport = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          access_token: token({ iss: "https://wrong.invalid/auth/v1" }),
          refresh_token: "private-refresh",
          token_type: "bearer",
          expires_in: 600,
          user,
        }),
      ),
  );
  await expect(
    privateLoginManifestVerifier(transport)(
      key,
      "fixture@example.invalid",
      "private-password",
    ),
  ).rejects.toThrow("PRIVATE_LOGIN_VERIFICATION_FAILED");
  expect(transport).toHaveBeenCalledTimes(1);
});
