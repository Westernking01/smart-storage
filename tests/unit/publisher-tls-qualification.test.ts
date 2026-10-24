import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  qualificationConfig,
  qualificationSql,
  qualify,
} from "../../scripts/publisher-tls-qualification";

it("requires disabled flags and rejects unsafe TLS before credentials or connection", () => {
  expect(() => qualificationConfig({})).toThrow("QUALIFICATION_FLAGS_INVALID");
  expect(() =>
    qualificationConfig({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
  ).toThrow("QUALIFICATION_ENV_INVALID");
});
it("uses the actual read-only audit and preflight without publication calls or commit", () => {
  const sql = qualificationSql();
  expect(sql).toContain("BEGIN READ ONLY;");
  expect(sql).toContain("ROLLBACK;");
  expect(sql).toContain("SET LOCAL ROLE ss_dev_cloud_publisher;");
  expect(sql).toContain("Transaction identity leaked");
  expect(sql).not.toMatch(/^\\/m);
  expect(sql).not.toMatch(/\bCOMMIT\s*;|SELECT public\.ss_/i);
  expect(sql).not.toContain("DISCARD ALL;");
});
const fake = (authorized = true) => ({
  connect: vi.fn(async () => {}),
  query: vi.fn(async (sql: string) => ({ rows: [], command: sql })),
  end: vi.fn(async () => {}),
  connection: {
    stream: {
      encrypted: true,
      authorized,
      authorizationError: undefined,
      getProtocol: () => "TLSv1.3",
      getPeerCertificate: () => ({
        subjectaltname: "DNS:aws-0-eu-west-1.pooler.supabase.com",
      }),
    },
  },
});
it("checks the actual client socket, resets before SQL and always closes", async () => {
  const client = fake();
  expect(await qualify(client as never, qualificationSql())).toBe("TLSv1.3");
  expect(client.query.mock.calls.map((c) => c[0])).toEqual([
    "DISCARD ALL",
    qualificationSql(),
    "ROLLBACK",
  ]);
  expect(client.end).toHaveBeenCalledOnce();
});
it.each(["trust", "hostname", "sql"])(
  "fails closed and cleans up after %s failure",
  async (failure) => {
    const client = fake(failure !== "trust");
    if (failure === "hostname")
      client.connection.stream.getPeerCertificate = () => ({
        subjectaltname: "DNS:wrong.example",
      });
    if (failure === "sql") client.query.mockRejectedValueOnce(Error("secret"));
    await expect(
      qualify(client as never, qualificationSql()),
    ).rejects.toThrow();
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.end).toHaveBeenCalledOnce();
  },
);
