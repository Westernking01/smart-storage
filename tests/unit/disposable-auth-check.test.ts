import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { checkOrdinaryAuthentication } from "../../experiments/storage/disposable-auth-check-cli";

it("cancellation prevents credential acquisition and every request", async () => {
  const hidden = vi.fn(async () => "cancel");
  const transport = vi.fn<typeof fetch>();
  await expect(
    checkOrdinaryAuthentication({ hidden, transport }),
  ).rejects.toThrow("CONFIRMATION_REQUIRED");
  expect(hidden).toHaveBeenCalledTimes(1);
  expect(transport).not.toHaveBeenCalled();
});

it("verifies only two Auth endpoints and returns no session", async () => {
  const uid = "310d0ec8-84ca-423a-b646-0480a20edc09";
  const origin = "https://rrylhvqalsxjnkdkpwde.supabase.co";
  const token = `e30.${Buffer.from(
    JSON.stringify({
      sub: uid,
      role: "authenticated",
      iss: `${origin}/auth/v1`,
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url")}.synthetic`;
  const answers = [
    "VERIFY DISPOSABLE AUTH",
    "sb_publishable_synthetic",
    "synthetic@example.invalid",
    "synthetic-password",
  ];
  const hidden = vi.fn(async () => answers.shift()!);
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        access_token: token,
        token_type: "bearer",
        user: { id: uid },
      }),
    )
    .mockResolvedValueOnce(Response.json({ id: uid, role: "authenticated" }));
  expect(
    await checkOrdinaryAuthentication({ hidden, transport }),
  ).toBeUndefined();
  expect(transport.mock.calls.map(([url]) => url)).toEqual([
    `${origin}/auth/v1/token?grant_type=password`,
    `${origin}/auth/v1/user`,
  ]);
  expect(hidden).toHaveBeenCalledTimes(4);
});
