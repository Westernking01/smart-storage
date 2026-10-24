import { expect, it, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  getUser: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  redirect: mocks.redirect,
}));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: ReactNode }) =>
    createElement("div", {}, children),
}));
vi.mock("@/lib/backend/operations", () => ({
  ownerContext: mocks.owner,
  BackendError: class extends Error {
    constructor(
      public code: string,
      public status: number,
    ) {
      super(code);
    }
  },
}));
import Account from "../../src/app/account/page";
import Loading from "../../src/app/account/loading";
import { BackendError } from "../../src/lib/backend/operations";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.owner.mockResolvedValue({
    id: A,
    client: { auth: { getUser: mocks.getUser } },
  });
  mocks.redirect.mockImplementation(() => {
    throw Error("REDIRECT");
  });
});
it("shows email only from a fresh matching ordinary verified identity and keeps UUID out of primary markup", async () => {
  mocks.getUser.mockResolvedValue({
    data: {
      user: {
        id: A,
        role: "authenticated",
        email_confirmed_at: "2026-10-24T00:00:00Z",
        email: "fixture@example.invalid",
      },
    },
    error: null,
  });
  const html = renderToStaticMarkup(await Account());
  expect(html).toContain("fixture@example.invalid");
  expect(html).toContain("Verified email");
  expect(html).not.toContain(A);
  expect(html).toContain("Copy account ID");
  expect(html).toContain('href="/update-password"');
  expect(html).toContain('href="/app"');
  expect(html).not.toContain("enrolled");
});
it.each(["mismatch", "unconfirmed", "provider-error", "throws"])(
  "does not display unverified email on %s",
  async (mode) => {
    const user = {
      id: mode === "mismatch" ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : A,
      role: "authenticated",
      email_confirmed_at:
        mode === "unconfirmed" ? null : "2026-10-24T00:00:00Z",
      email: "do-not-display@example.invalid",
    };
    if (mode === "throws")
      mocks.getUser.mockRejectedValue(
        Error("provider detail must stay private"),
      );
    else
      mocks.getUser.mockResolvedValue({
        data: { user },
        error: mode === "provider-error" ? Error("provider detail") : null,
      });
    const html = renderToStaticMarkup(await Account());
    expect(html).not.toContain(user.email);
    expect(html).not.toContain("provider detail");
    expect(html).toContain("Email unavailable");
    expect(html).toContain("Copy account ID");
  },
);
it("retains the existing unauthenticated redirect", async () => {
  mocks.owner.mockRejectedValue(new BackendError("UNAUTHENTICATED", 401));
  await expect(Account()).rejects.toThrow("REDIRECT");
  expect(mocks.redirect).toHaveBeenCalledWith("/login?next=/account");
  expect(mocks.getUser).not.toHaveBeenCalled();
});
it("renders a bounded error state without identity details on backend failure", async () => {
  mocks.owner.mockRejectedValue(Error("private backend detail"));
  const html = renderToStaticMarkup(await Account());
  expect(html).toContain("Account details unavailable");
  expect(html).not.toContain("private backend detail");
  expect(html).not.toContain(A);
  expect(mocks.getUser).not.toHaveBeenCalled();
});
it("provides a structured loading state", () => {
  const html = renderToStaticMarkup(createElement(Loading));
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain("Loading account details");
  expect(html).not.toContain(A);
});
