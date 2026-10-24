import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ config: vi.fn(), account: vi.fn() }));
vi.mock("@/lib/backend/development-cloud-config", () => ({
  developmentCloudConfig: mocks.config,
}));
vi.mock("@/lib/supabase/server", () => ({ verifiedAccount: mocks.account }));
import { cloudPageAccess } from "@/components/cloud-page-access";
beforeEach(() => vi.resetAllMocks());
it("does not query Auth when cloud is disabled", async () => {
  mocks.config.mockReturnValue(null);
  expect(await cloudPageAccess()).toEqual({ state: "disabled" });
  expect(mocks.account).not.toHaveBeenCalled();
});
it("distinguishes unauthenticated access", async () => {
  mocks.config.mockReturnValue({});
  mocks.account.mockResolvedValue(null);
  expect(await cloudPageAccess()).toEqual({ state: "unauthenticated" });
});
it("retains verified account context", async () => {
  const account = { id: "verified-owner" };
  mocks.config.mockReturnValue({});
  mocks.account.mockResolvedValue(account);
  expect(await cloudPageAccess()).toEqual({ state: "authenticated", account });
});
it.each(["config", "account"] as const)(
  "reports %s failure without presenting empty data",
  async (source) => {
    mocks.config.mockReturnValue({});
    mocks[source].mockImplementation(() => {
      throw Error("private-detail");
    });
    expect(await cloudPageAccess()).toEqual({ state: "error" });
  },
);
