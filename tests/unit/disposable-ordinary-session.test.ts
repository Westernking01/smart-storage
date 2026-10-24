import { expect, it, vi } from "vitest";
import { ordinarySessionBridge } from "../../experiments/storage/disposable-ordinary-session";

const uid = "310d0ec8-84ca-423a-b646-0480a20edc09";
const url = "https://rrylhvqalsxjnkdkpwde.supabase.co";
const jwt = (overrides = {}) =>
  `e30.${Buffer.from(
    JSON.stringify({
      sub: uid,
      role: "authenticated",
      iss: `${url}/auth/v1`,
      aud: "authenticated",
      exp: 2000000000,
      ...overrides,
    }),
  ).toString("base64url")}.synthetic`;
function setup(
  options: {
    claims?: object;
    loginUser?: string;
    verifiedUser?: string;
    status?: number;
    verifiedStatus?: number;
    key?: string;
    reject?: boolean;
  } = {},
) {
  const token = jwt(options.claims);
  const transport = vi
    .fn<typeof fetch>()
    .mockImplementation(async (_url, init) => {
      if (options.reject) throw Error("private-password-and-token");
      if (init?.method === "POST")
        return Response.json(
          {
            access_token: token,
            refresh_token: "synthetic-unused",
            token_type: "bearer",
            user: { id: options.loginUser ?? uid },
          },
          { status: options.status ?? 200 },
        );
      return Response.json(
        {
          id: options.verifiedUser ?? uid,
          role: "authenticated",
        },
        { status: options.verifiedStatus ?? 200 },
      );
    });
  const credentials = vi.fn(async () => ({
    email: "synthetic@example.invalid",
    password: "synthetic-private",
  }));
  const bridge = ordinarySessionBridge({
    publicUrl: url,
    publicKey: options.key ?? "sb_publishable_synthetic",
    credentials,
    transport,
    now: () => 1900000000000,
  });
  return { bridge, transport, credentials, token };
}

it("is lazy and verifies the exact ordinary bearer through Auth without storage", async () => {
  const s = setup();
  expect(s.transport).not.toHaveBeenCalled();
  const result = await s.bridge();
  expect(result.userId).toBe(uid);
  expect(result.accessToken).toBe(s.token);
  expect(s.transport.mock.calls.map(([url]) => url)).toEqual([
    `${url}/auth/v1/token?grant_type=password`,
    `${url}/auth/v1/user`,
  ]);
  expect(s.transport.mock.calls[1][1]?.headers).toMatchObject({
    Authorization: `Bearer ${s.token}`,
  });
  expect(
    s.transport.mock.calls.every(([, init]) => init?.redirect === "error"),
  ).toBe(true);
  await expect(s.bridge()).rejects.toThrow("ORDINARY_AUTH_ALREADY_ATTEMPTED");
  expect(s.transport).toHaveBeenCalledTimes(2);
});

it.each([
  { verifiedStatus: 401 },
  { status: 400 },
  { status: 401 },
  { status: 500 },
  { reject: true },
  { loginUser: "wrong" },
  { verifiedUser: "wrong" },
  { claims: { sub: "wrong" } },
  { claims: { role: "service_role" } },
  { claims: { iss: "https://other.invalid/auth/v1" } },
  { claims: { aud: "anon" } },
  { claims: { exp: 1 } },
  { key: "sb_secret_synthetic" },
  { key: jwt({ role: "service_role" }) },
])("fails closed and redacts authentication failure: %j", async (options) => {
  const s = setup(options);
  await expect(s.bridge()).rejects.toThrow(/^ORDINARY_AUTH_FAILED$/);
  const calls = s.transport.mock.calls.length;
  await expect(s.bridge()).rejects.toThrow("ORDINARY_AUTH_ALREADY_ATTEMPTED");
  expect(s.transport).toHaveBeenCalledTimes(calls);
  expect(calls).toBeLessThanOrEqual(2);
  if (options.key) expect(s.credentials).not.toHaveBeenCalled();
});

it("refuses other projects before reading credentials", async () => {
  const credentials = vi.fn();
  const transport = vi.fn();
  await expect(
    ordinarySessionBridge({
      publicUrl: "https://other.invalid",
      publicKey: "sb_publishable_synthetic",
      credentials,
      transport,
    })(),
  ).rejects.toThrow("ORDINARY_AUTH_FAILED");
  expect(credentials).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});
