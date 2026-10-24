import type { Pool } from "pg";
import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { postgresPublisher } from "../../src/lib/backend/development-publisher-postgres.server";

const owner = "00000000-0000-4000-8000-000000000123";

// Offline only: intercept every query; never construct a Pool or invoke an RPC.
it.each([
  "DISCARD ALL",
  "BEGIN",
  "SET LOCAL ROLE",
  "set_config",
  "SELECT public.",
  "COMMIT",
])(
  "destroys the checkout without retry after failure at %s, even if rollback fails",
  async (stage) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes(stage) || sql === "ROLLBACK")
        throw Error("private provider diagnostic");
      return {
        rows: [{ login: "ss_dev_cloud_publisher_login", result: null }],
      };
    });
    const release = vi.fn();
    const connect = vi.fn(async () => ({ query, release }));
    const authority = postgresPublisher(
      { connect } as unknown as Pick<Pool, "connect">,
      async () => owner,
    );
    await expect(
      authority.trusted("ss_finish_attempt_request", {
        p_request: owner,
        p_offset: null,
      }),
    ).rejects.toThrow(/^CLOUD_TRUSTED_RPC_UNAVAILABLE$/);
    expect(connect).toHaveBeenCalledOnce();
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(release.mock.calls).toEqual([[true]]);
    expect(
      query.mock.calls.filter(([sql]) => sql.includes("SELECT public.")),
    ).toHaveLength(["SELECT public.", "COMMIT"].includes(stage) ? 1 : 0);
  },
);

it("rejects caller identity overrides and inherited RPC names before identity or checkout", async () => {
  const connect = vi.fn();
  const verify = vi.fn(async () => owner);
  const authority = postgresPublisher({ connect }, verify);
  for (const [name, args] of [
    [
      "ss_finish_attempt_request",
      { p_request: owner, p_offset: null, sub: owner },
    ],
    ["constructor", {}],
    ["ss_list_files", {}],
  ] as const)
    await expect(authority.trusted(name, args)).rejects.toThrow(
      "DEV_PUBLISHER_RPC_INVALID",
    );
  expect(verify).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});
