import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { developmentUserVerifier } from "../../src/lib/backend/development-user-verifier.server";

const id = "00000000-0000-4000-8000-000000000123";
const other = "00000000-0000-4000-8000-000000000124";
const token = "fixture.payload.signature";
function fixture() {
  const user = {
    id,
    role: "authenticated",
    is_anonymous: false,
    email_confirmed_at: "2026-01-01T00:00:00Z",
  };
  const claims = {
    iss: "https://fneuqneqaopkmpeevlqz.supabase.co/auth/v1",
    sub: id,
    role: "authenticated",
    is_anonymous: false,
    exp: Date.now() / 1000 + 3600,
  };
  const auth = {
    getSession: vi.fn(async () => ({
      data: { session: { access_token: token } },
      error: null,
    })),
    getUser: vi.fn(async () => ({ data: { user }, error: null })),
    getClaims: vi.fn(async () => ({ data: { claims }, error: null })),
  };
  const create = () =>
    developmentUserVerifier(auth as unknown as SupabaseClient["auth"]);
  return { auth, user, claims, create };
}

it("returns only identity and a fresh bound verifier without a Storage client", async () => {
  const f = fixture();
  const verifier = await f.create();
  expect(Object.keys(verifier).sort()).toEqual(["id", "verify"]);
  expect(verifier.id).toBe(id);
  expect(await verifier.verify()).toBe(id);
  expect(f.auth.getUser.mock.calls).toEqual([[token], [token]]);
  expect(f.auth.getClaims.mock.calls).toEqual([[token], [token]]);
});

it.each([
  "expired",
  "wrong-subject",
  "wrong-issuer",
  "publisher-role",
  "anonymous",
  "missing-anonymous",
  "invalid-expiry",
])("rejects %s claims", async (kind) => {
  const f = fixture();
  if (kind === "expired") f.claims.exp = 1;
  if (kind === "wrong-subject") f.claims.sub = other;
  if (kind === "wrong-issuer") f.claims.iss = "https://other.invalid/auth/v1";
  if (kind === "publisher-role") f.claims.role = "ss_dev_cloud_publisher";
  if (kind === "anonymous") f.claims.is_anonymous = true;
  if (kind === "missing-anonymous")
    Reflect.deleteProperty(f.claims, "is_anonymous");
  if (kind === "invalid-expiry") f.claims.exp = NaN;
  await expect(f.create()).rejects.toThrow(/^DEV_USER_VERIFICATION_FAILED$/);
});

it.each(["anonymous", "unconfirmed", "unauthorized", "invalid-id"])(
  "rejects %s Auth user",
  async (kind) => {
    const f = fixture();
    if (kind === "anonymous") f.user.is_anonymous = true;
    if (kind === "unconfirmed") f.user.email_confirmed_at = "";
    if (kind === "unauthorized") f.user.role = "service_role";
    if (kind === "invalid-id") f.user.id = "invalid";
    await expect(f.create()).rejects.toThrow(/^DEV_USER_VERIFICATION_FAILED$/);
    expect(f.auth.getClaims).not.toHaveBeenCalled();
  },
);

it.each(["", "malformed", "a.b.c.extra", "a.b.!", "a".repeat(16385)])(
  "rejects missing/malformed token (%#) before Auth dispatch",
  async (candidate) => {
    const f = fixture();
    f.auth.getSession.mockResolvedValueOnce({
      data: { session: { access_token: candidate } },
      error: null,
    });
    await expect(f.create()).rejects.toThrow(/^DEV_USER_VERIFICATION_FAILED$/);
    expect(f.auth.getUser).not.toHaveBeenCalled();
  },
);

it.each(["getSession", "getUser", "getClaims"] as const)(
  "masks %s exceptions and returned authorization errors",
  async (method) => {
    for (const throws of [false, true]) {
      const f = fixture();
      const failure = Error("sensitive provider diagnostic");
      if (throws) f.auth[method].mockRejectedValueOnce(failure);
      else
        f.auth[method].mockImplementationOnce(async () => {
          return { data: {}, error: failure } as never;
        });
      await expect(f.create()).rejects.toThrow(
        /^DEV_USER_VERIFICATION_FAILED$/,
      );
      expect(f.auth[method]).toHaveBeenCalledOnce();
    }
  },
);

it.each(["expiry", "identity-switch", "revocation"])(
  "fails fresh verification after simulated pool wait: %s",
  async (kind) => {
    const f = fixture();
    const verifier = await f.create();
    if (kind === "expiry") f.claims.exp = 1;
    if (kind === "identity-switch") {
      f.user.id = other;
      f.claims.sub = other;
    }
    if (kind === "revocation")
      f.auth.getUser.mockRejectedValueOnce(Error("revoked"));
    await expect(verifier.verify()).rejects.toThrow(
      /^DEV_USER_VERIFICATION_FAILED$/,
    );
    expect(f.auth.getUser).toHaveBeenCalledTimes(2);
  },
);
