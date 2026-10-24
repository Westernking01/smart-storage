import { describe, expect, it } from "vitest";
import { createBrowserClient, createServerClient } from "@supabase/ssr";

const projectUrl = "https://fixture-project.supabase.co";
const publishable = "sb_publishable_abcdefghijklmnopqrstuv";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const accessToken = `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: owner, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`;
const user = {
  id: owner,
  aud: "authenticated",
  role: "authenticated",
  email: "fixture@example.invalid",
  email_confirmed_at: "2026-01-01T00:00:00Z",
  is_anonymous: false,
  app_metadata: {},
  user_metadata: {},
  created_at: "2026-01-01T00:00:00Z",
};
const authResponse = () =>
  new Response(JSON.stringify(user), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("Supabase SSR cookie round trip", () => {
  it("reconstructs an SDK cookie and verifies identity on the server", async () => {
    let cookies: {
      name: string;
      value: string;
      options?: Record<string, unknown>;
    }[] = [];
    const browserFetch = async () => authResponse();
    const browser = createBrowserClient(projectUrl, publishable, {
      isSingleton: false,
      global: { fetch: browserFetch },
      cookies: {
        getAll: () => cookies,
        setAll: (next) => {
          cookies = next.filter((cookie) => cookie.value);
        },
      },
    });
    const session = await browser.auth.setSession({
      access_token: accessToken,
      refresh_token: "synthetic-refresh-token-for-local-test-only",
    });
    expect(session.error).toBeNull();
    expect(cookies.map(({ name }) => name)).toEqual([
      "sb-fixture-project-auth-token",
    ]);

    let authorization: string | null = null;
    const server = createServerClient(projectUrl, publishable, {
      global: {
        fetch: async (_input, init) => {
          authorization = new Headers(init?.headers).get("authorization");
          return authResponse();
        },
      },
      cookies: { getAll: () => cookies, setAll: () => {} },
    });
    const verified = await server.auth.getUser();
    expect(verified.error).toBeNull();
    expect(verified.data.user?.id).toBe(owner);
    expect(authorization).toBe(`Bearer ${accessToken}`);
  });

  it("reassembles chunked cookie values without trusting a user id", async () => {
    let cookies: { name: string; value: string }[] = [];
    const browser = createBrowserClient(projectUrl, publishable, {
      isSingleton: false,
      global: { fetch: async () => authResponse() },
      cookies: {
        getAll: () => cookies,
        setAll: (next) => {
          cookies = next.filter((cookie) => cookie.value);
        },
      },
    });
    await browser.auth.setSession({
      access_token: accessToken,
      refresh_token: `fixture-${"x".repeat(7000)}`,
    });
    expect(cookies.length).toBeGreaterThan(1);
    expect(cookies.every(({ name }, index) => name.endsWith(`.${index}`))).toBe(
      true,
    );
  });
});
