import { expect, it, vi } from "vitest";
import { checkBucketMetadata } from "../../experiments/storage/disposable-metadata-check";

const origin = "https://rrylhvqalsxjnkdkpwde.supabase.co";
const uid = "310d0ec8-84ca-423a-b646-0480a20edc09";
const token = `e30.${Buffer.from(JSON.stringify({ sub: uid, role: "authenticated", iss: `${origin}/auth/v1`, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.synthetic`;
const bucket = {
  id: "smart-storage-gateway-probe",
  name: "smart-storage-gateway-probe",
  public: false,
  file_size_limit: 52428800,
  allowed_mime_types: null,
};
function setup(response: Response | Error, identity = uid) {
  const answers = [
    "sb_publishable_synthetic",
    "synthetic@example.invalid",
    "secret-password",
  ];
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        access_token: token,
        token_type: "bearer",
        user: { id: uid },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ id: identity, role: "authenticated" }),
    );
  if (response instanceof Error) transport.mockRejectedValueOnce(response);
  else transport.mockResolvedValueOnce(response);
  return { hidden: vi.fn(async () => answers.shift()!), transport };
}
it("uses exactly login, identity and one bearer-only metadata GET; exports allowlisted fields", async () => {
  const input = setup(Response.json({ ...bucket, secret: token }));
  const result = await checkBucketMetadata(input);
  expect(result.outcome).toBe("PASS");
  expect(result.bucket).toEqual(bucket);
  expect(input.transport.mock.calls.map(([url]) => url)).toEqual([
    `${origin}/auth/v1/token?grant_type=password`,
    `${origin}/auth/v1/user`,
    `${origin}/storage/v1/bucket/${bucket.id}`,
  ]);
  const options = input.transport.mock.calls[2][1]!;
  expect(options.method).toBe("GET");
  expect(options.redirect).toBe("error");
  expect(options.body).toBeUndefined();
  expect(options.headers).toEqual({
    Authorization: `Bearer ${token}`,
    "Accept-Encoding": "identity",
  });
  expect(JSON.stringify(result)).not.toContain(token);
  expect(JSON.stringify(result)).not.toContain("secret-password");
});
it("stops after identity rejection without Storage", async () => {
  const input = setup(Response.json(bucket), "wrong");
  expect((await checkBucketMetadata(input)).reason).toBe("AUTH_UNVERIFIED");
  expect(input.transport).toHaveBeenCalledTimes(2);
});
it.each([
  ["denied", () => new Response("secret-provider-body", { status: 403 })],
  ["malformed", () => new Response("secret-provider-body")],
  ["oversized", () => new Response("x".repeat(65537))],
  ["wrong bucket", () => Response.json({ ...bucket, public: true })],
  [
    "missing MIME",
    () => Response.json({ ...bucket, allowed_mime_types: undefined }),
  ],
  [
    "encoding",
    () =>
      new Response("secret-provider-body", {
        headers: { "content-encoding": "gzip" },
      }),
  ],
  ["network", () => new Error(`secret-provider-body ${token}`)],
] as const)(
  "fails closed without retry or raw output: %s",
  async (_name, response) => {
    const input = setup(response());
    const result = await checkBucketMetadata(input);
    expect(result.outcome).toBe("BLOCKED");
    expect(input.transport).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain("secret-provider-body");
    expect(JSON.stringify(result)).not.toContain(token);
  },
);
it("cancellation before credentials prevents every request", async () => {
  const input = {
    hidden: vi.fn(async () => {
      throw Error("private input cancelled");
    }),
    transport: vi.fn<typeof fetch>(),
  };
  expect((await checkBucketMetadata(input)).outcome).toBe("BLOCKED");
  expect(input.transport).not.toHaveBeenCalled();
});
