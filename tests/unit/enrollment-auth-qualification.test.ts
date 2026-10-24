import { expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
vi.mock("server-only", () => ({}));
import {
  qualificationFetch,
  qualificationFailureLine,
  runEnrollmentQualification,
} from "../../scripts/enrollment-auth-qualification";

const id = "00000000-0000-4000-8000-000000000123";
it.each([400, 401, 403])(
  "intercepts actual SDK sign-in rejection %s, with publishable key only in apikey",
  async (status) => {
    const f = fixture();
    const apiKey = "sb_publishable_synthetic_offline_fixture";
    const base = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("apikey")).toBe(apiKey);
      expect(headers.has("authorization")).toBe(false);
      expect(JSON.parse(init?.body as string)).toMatchObject({
        email: "fixture@example.invalid",
        password: "private-fixture",
      });
      return new Response(
        JSON.stringify({ msg: "sensitive provider diagnostic" }),
        { status, headers: { "content-type": "application/json" } },
      );
    });
    const client = createClient(
      "https://fneuqneqaopkmpeevlqz.supabase.co",
      apiKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: { fetch: qualificationFetch(base) },
      },
    );
    const error = await runEnrollmentQualification(
      client.auth,
      f.db as never,
      f.credentials,
      id,
    ).catch((error: unknown) => error);
    expect(qualificationFailureLine(error)).toBe(
      "FAIL: enrollment qualification [AUTH_REJECTED]; stop without retry or activation.",
    );
    expect(base).toHaveBeenCalledOnce();
    expect(base.mock.calls[0][0]).toBe(
      "https://fneuqneqaopkmpeevlqz.supabase.co/auth/v1/token?grant_type=password",
    );
    expect(f.db.connect).not.toHaveBeenCalled();
    expect(f.db.end).toHaveBeenCalledOnce();
  },
);
it("preserves an explicit ordinary access token on the actual SDK getUser request", async () => {
  const token = "fixture.payload.signature";
  const base = vi.fn<typeof fetch>(async (_input, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${token}`,
    );
    return new Response("{}", { status: 403 });
  });
  const client = createClient(
    "https://fneuqneqaopkmpeevlqz.supabase.co",
    "sb_publishable_synthetic_offline_fixture",
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: qualificationFetch(base) },
    },
  );
  await client.auth.getUser(token);
  expect(base).toHaveBeenCalledOnce();
});
it.each(["getSession", "getUser", "getClaims"] as const)(
  "never maps %s rejection to password AUTH_REJECTED",
  async (method) => {
    const f = fixture();
    f.auth[method].mockResolvedValueOnce({
      data: {},
      error: { status: 403, message: "sensitive provider diagnostic" },
    } as never);
    const error = await f.run().catch((error: unknown) => error);
    expect(qualificationFailureLine(error)).toBe(
      "FAIL: enrollment qualification [AUTH_VALIDATION_FAILED]; stop without retry or activation.",
    );
    expect(f.db.connect).not.toHaveBeenCalled();
  },
);
function fixture() {
  const user = {
    id,
    role: "authenticated",
    is_anonymous: false,
    email_confirmed_at: "2026-01-01T00:00:00Z",
  };
  const auth = {
    signInWithPassword: vi.fn(async () => ({ error: null })),
    getSession: vi.fn(async () => ({
      data: { session: { access_token: "fixture.payload.signature" } },
      error: null,
    })),
    getUser: vi.fn(async () => ({ data: { user }, error: null })),
    getClaims: vi.fn(async () => ({
      data: {
        claims: {
          sub: id,
          role: "authenticated",
          is_anonymous: false,
          iss: "https://fneuqneqaopkmpeevlqz.supabase.co/auth/v1",
          exp: Date.now() / 1000 + 600,
        },
      },
      error: null,
    })),
  };
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => ({
    rows: [
      sql.includes(" AS enrolled")
        ? {
            login: "ss_dev_cloud_publisher_login",
            role: "ss_dev_cloud_publisher",
            read_only: "on",
            context_matches: true,
            legacy_clear: true,
            enrolled: true,
          }
        : sql.includes(" AS clean")
          ? {
              login: "ss_dev_cloud_publisher_login",
              role: "ss_dev_cloud_publisher_login",
              clean: true,
            }
          : { login: "ss_dev_cloud_publisher_login" },
    ],
  }));
  const db = {
    connect: vi.fn(async () => ({ query, release })),
    end: vi.fn(async () => {}),
  };
  const credentials = {
    email: "fixture@example.invalid",
    password: "private-fixture",
  };
  const run = () =>
    runEnrollmentQualification(auth as never, db as never, credentials, id);
  return { auth, db, credentials, user, run, query, release };
}
it("signs in once then reuses the real verifier/probe and closes the pool", async () => {
  const f = fixture();
  await expect(f.run()).resolves.toEqual({ verified: true });
  expect(f.auth.signInWithPassword).toHaveBeenCalledOnce();
  expect(f.auth.getUser).toHaveBeenCalledTimes(2);
  expect(f.credentials.password).toBe("");
  expect(f.db.end).toHaveBeenCalledOnce();
  expect(f.release).toHaveBeenCalledWith(false);
});
it.each([
  ["signin", "AUTH_REQUEST_FAILED"],
  ["wrong-account", "IDENTITY_MISMATCH"],
  ["checkout", "DATABASE_CONNECTION_FAILED"],
  ["close", "CLEANUP_FAILED"],
])("masks %s and closes without retry", async (failure, category) => {
  const f = fixture();
  if (failure === "signin")
    f.auth.signInWithPassword.mockRejectedValueOnce(Error("private"));
  if (failure === "wrong-account")
    f.user.id = "00000000-0000-4000-8000-000000000124";
  if (failure === "checkout")
    f.db.connect.mockRejectedValueOnce(Error("private"));
  if (failure === "close") f.db.end.mockRejectedValueOnce(Error("private"));
  const error = await f.run().catch((error: unknown) => error);
  expect(qualificationFailureLine(error)).toBe(
    `FAIL: enrollment qualification [${category}]; stop without retry or activation.`,
  );
  expect(f.db.end).toHaveBeenCalledOnce();
  if (["signin", "wrong-account"].includes(failure))
    expect(f.db.connect).not.toHaveBeenCalled();
});
it.each([
  ["rejected", "AUTH_REJECTED"],
  ["server-error", "AUTH_REQUEST_FAILED"],
  ["session", "AUTH_VALIDATION_FAILED"],
  ["claims", "AUTH_VALIDATION_FAILED"],
  ["post-checkout", "AUTH_VALIDATION_FAILED"],
  ["context", "DATABASE_CONTEXT_FAILED"],
  ["sql", "DATABASE_CONTEXT_FAILED"],
  ["denied", "ENROLLMENT_DENIED"],
  ["null-enrollment", "DATABASE_CONTEXT_FAILED"],
  ["bad-context-denied", "DATABASE_CONTEXT_FAILED"],
  ["rollback", "CLEANUP_FAILED"],
  ["failed-rollback", "CLEANUP_FAILED"],
  ["cleanup", "CLEANUP_FAILED"],
  ["release", "CLEANUP_FAILED"],
])(
  "safely classifies %s without leaking diagnostics",
  async (stage, category) => {
    const f = fixture();
    const secret =
      "password token refresh_token postgresql://private@example.invalid/user-id";
    if (stage === "rejected" || stage === "server-error")
      f.auth.signInWithPassword.mockResolvedValueOnce({
        error: { status: stage === "rejected" ? 400 : 503, message: secret },
      } as never);
    if (stage === "session")
      f.auth.getSession.mockRejectedValueOnce(Error(secret));
    if (stage === "claims")
      f.auth.getClaims.mockRejectedValueOnce(Error(secret));
    if (stage === "post-checkout")
      f.auth.getUser
        .mockResolvedValueOnce({ data: { user: f.user }, error: null })
        .mockRejectedValueOnce(Error(secret));
    if (stage === "release")
      f.release.mockImplementationOnce(() => {
        throw Error(secret);
      });
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql) => {
      if (
        (stage === "context" && sql === "DISCARD ALL") ||
        (stage === "sql" && sql.includes(" AS enrolled")) ||
        (["rollback", "failed-rollback"].includes(stage) && sql === "ROLLBACK")
      )
        throw Error(secret);
      const result = await original(sql);
      const row = result.rows[0] as Record<string, unknown>;
      if (sql.includes(" AS enrolled")) {
        if (["denied", "bad-context-denied", "failed-rollback"].includes(stage))
          row.enrolled = false;
        if (stage === "null-enrollment") row.enrolled = null;
        if (stage === "bad-context-denied") row.context_matches = false;
      }
      if (stage === "cleanup" && sql.includes(" AS clean")) row.clean = false;
      return result;
    });
    const error = await f.run().catch((error: unknown) => error);
    expect(qualificationFailureLine(error)).toBe(
      `FAIL: enrollment qualification [${category}]; stop without retry or activation.`,
    );
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(f.auth.signInWithPassword).toHaveBeenCalledOnce();
    expect(f.db.end).toHaveBeenCalledOnce();
    expect(f.credentials.password).toBe("");
    if (
      stage === "session" ||
      stage === "claims" ||
      stage === "rejected" ||
      stage === "server-error"
    )
      expect(f.db.connect).not.toHaveBeenCalled();
    if (
      [
        "context",
        "sql",
        "denied",
        "bad-context-denied",
        "failed-rollback",
        "rollback",
        "cleanup",
        "post-checkout",
      ].includes(stage)
    )
      expect(f.release).toHaveBeenCalledWith(true);
  },
);
it("never renders arbitrary errors or forged category metadata", () => {
  for (const error of [
    Error("secret"),
    { category: "AUTH_REJECTED", message: "secret" },
    Object.assign(Error("CLEANUP_FAILED"), {
      qualificationCategory: "CLEANUP_FAILED",
    }),
    null,
  ]) {
    expect(qualificationFailureLine(error)).toBe(
      "FAIL: enrollment qualification [QUALIFICATION_FAILED]; stop without retry or activation.",
    );
  }
});
it("bounds Auth endpoints, rejects redirects and prevents password exchange retries", async () => {
  const base = vi.fn(async () => new Response("{}"));
  const limited = qualificationFetch(base);
  const url =
    "https://fneuqneqaopkmpeevlqz.supabase.co/auth/v1/token?grant_type=password";
  await limited(url, { method: "POST" });
  await expect(limited(url, { method: "POST" })).rejects.toThrow(
    "ENROLLMENT_AUTH_REQUEST_DENIED",
  );
  await expect(limited("https://other.invalid/auth/v1/user")).rejects.toThrow();
  await expect(
    limited("https://fneuqneqaopkmpeevlqz.supabase.co/storage/v1/object"),
  ).rejects.toThrow();
  expect(base).toHaveBeenCalledOnce();
  expect(base.mock.calls[0]).toEqual([
    url,
    expect.objectContaining({
      redirect: "error",
      signal: expect.any(AbortSignal),
    }),
  ]);
});
