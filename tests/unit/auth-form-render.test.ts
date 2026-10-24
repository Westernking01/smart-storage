import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
import { AuthForm } from "@/components/auth-form";

describe("authentication form availability", () => {
  it.each(["login", "register", "reset"] as const)(
    "enables the %s submit control when development authentication is enabled",
    (mode) => {
      const html = renderToStaticMarkup(
        createElement(AuthForm, { mode, enabled: true }),
      );
      expect(html).toMatch(/<button[^>]*type="submit"/);
      expect(html).not.toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    },
  );

  it("blocks submission but keeps fields editable when connectivity is disabled", () => {
    const html = renderToStaticMarkup(
      createElement(AuthForm, { mode: "login", enabled: false }),
    );
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    expect(html).not.toMatch(/<input[^>]*disabled/);
  });
});
