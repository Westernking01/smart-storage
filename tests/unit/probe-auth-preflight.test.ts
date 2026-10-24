import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  preflightProbeAuthentication,
  preflightSeededFixtureAuthentication,
} from "../../src/lib/gateway/probe-auth-preflight.server";
const load = (name: string) =>
  JSON.parse(
    readFileSync(
      `experiments/storage/disposable-probe.${name}.template.json`,
      "utf8",
    ).replace(/^\uFEFF/, ""),
  );
const plan = load("auth");
const pending = load("permissions");
const reviewed = Object.fromEntries(
  Object.entries(pending).map(([k, v]) => [
    k,
    v === false
      ? true
      : k === "reviewReference"
        ? "operator-reviewed-catalog-record"
        : v,
  ]),
);
describe("local authentication preparation", () => {
  const seeded = {
    ...JSON.parse(
      readFileSync(
        "experiments/storage/seeded-fixture.permissions.template.json",
        "utf8",
      ),
    ),
    reviewReference: "existing-policy-record#policyReview",
    checkedRoleMembershipsReviewed: true,
    reportedSelectBoundaryReviewed: true,
    reportedMutationPolicyAbsenceReviewed: true,
  };
  it("accepts configuration evidence only in the seeded workflow", () => {
    expect(() =>
      preflightSeededFixtureAuthentication(plan, seeded),
    ).not.toThrow();
    expect(() => preflightProbeAuthentication(plan, seeded)).toThrow();
    expect(() =>
      preflightSeededFixtureAuthentication(plan, reviewed),
    ).toThrow();
  });
  it.each(Object.keys(seeded))(
    "requires seeded configuration field %s",
    (key) => {
      const r = { ...seeded };
      delete r[key];
      expect(() => preflightSeededFixtureAuthentication(plan, r)).toThrow();
    },
  );
  it.each([
    { reportedSelectBoundaryReviewed: false },
    { reportedMutationPolicyAbsenceReviewed: false },
    { checkedRoleMembershipsReviewed: false },
    { effectiveStorageApiBehavior: "VERIFIED" },
    { noBroaderEffectiveAccess: true },
    { noWriteOrAdministrativeAccess: true },
    { key: "gateway-probe/v1/other.txt" },
    { reviewReference: "" },
  ])("rejects unsupported seeded claim or scope %j", (patch) => {
    expect(() =>
      preflightSeededFixtureAuthentication(plan, { ...seeded, ...patch }),
    ).toThrow();
  });
  it("keeps incomplete review blocked", () =>
    expect(() => preflightProbeAuthentication(plan, pending)).toThrow());
  it("accepts complete nonsecret plan and review only", () =>
    expect(preflightProbeAuthentication(plan, reviewed)).toEqual({
      readyForSeparateAuthenticationAuthorization: true,
    }));
  it.each([
    { project: "fneuqneqaopkmpeevlqz" },
    { persistSession: true },
    { autoRefreshToken: true },
    { apiKeyKind: "service_role" },
    { maximumSignInAttempts: 2 },
    { enabled: true },
    { password: "must-not-be-accepted" },
  ])("rejects unsafe plan %j", (patch) =>
    expect(() =>
      preflightProbeAuthentication({ ...plan, ...patch }, reviewed),
    ).toThrow(),
  );
  it.each(Object.keys(reviewed))("requires permission field %s", (key) => {
    const review = { ...reviewed };
    delete review[key];
    expect(() => preflightProbeAuthentication(plan, review)).toThrow();
  });
});
