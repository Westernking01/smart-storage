// Offline proposal evaluator only. No driver, credentials or execution path.
export const affected = Object.freeze([
  "ss_gateway_executor",
  "ss_gateway_observer",
  "ss_gateway_finalizer",
  "ss_gateway_cleaner",
  "ss_volume_gateway",
]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (o, names) =>
  o &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  same(Object.keys(o).sort(), [...names].sort());
const roleFields = [
  "name",
  "login",
  "super",
  "inherit",
  "bypass",
  "createRole",
  "createDb",
  "replication",
];
const aclFields = ["grantee", "grantor", "privilege", "grantable"];
const effFields = [
  "name",
  "usage",
  "create",
  "ownerMember",
  "ownerUsage",
  "ownerSet",
];
const memberFields = ["role", "member", "grantor", "admin", "inherit", "set"];

export function evaluatePublicAclProposal(e, contract) {
  const result = (status, reason, candidates = {}) => ({
    status,
    reason,
    compatibilityOnly: true,
    migrationsApplied: false,
    qualificationReady: false,
    adr041: "OPEN",
    transfersEnabled: false,
    entries: affected.map((grantee) => ({
      schema: "public",
      grantee,
      privilege: "USAGE",
      expectedGrantor: "postgres",
      status: candidates[grantee]?.status ?? status,
      reason: candidates[grantee]?.reason ?? reason,
    })),
  });
  if (
    !keys(e, [
      "version",
      "targetVerified",
      "databaseOwnerIsPostgres",
      "schemaOwnerIsDatabaseOwnerRole",
      "aclIsExplicit",
      "roles",
      "memberships",
      "acl",
      "effective",
    ]) ||
    e.version !== 1 ||
    !["roles", "memberships", "acl", "effective"].every((k) =>
      Array.isArray(e[k]),
    ) ||
    ![
      "targetVerified",
      "databaseOwnerIsPostgres",
      "schemaOwnerIsDatabaseOwnerRole",
      "aclIsExplicit",
    ].every((k) => typeof e[k] === "boolean") ||
    !e.roles.every(
      (r) =>
        keys(r, roleFields) &&
        roleFields.slice(1).every((k) => typeof r[k] === "boolean"),
    ) ||
    !e.acl.every(
      (r) => keys(r, aclFields) && typeof r.grantable === "boolean",
    ) ||
    !e.effective.every(
      (r) =>
        keys(r, effFields) &&
        effFields.slice(1).every((k) => typeof r[k] === "boolean"),
    ) ||
    !e.memberships.every(
      (r) =>
        keys(r, memberFields) &&
        ["admin", "inherit", "set"].every((k) => typeof r[k] === "boolean"),
    )
  )
    return result("BLOCKED", "INCOMPLETE_OR_UNSUPPORTED_EVIDENCE");
  if (!e.targetVerified) return result("BLOCKED", "TARGET_UNVERIFIED");
  if (!e.databaseOwnerIsPostgres || !e.schemaOwnerIsDatabaseOwnerRole)
    return result("CONFLICT", "OWNERSHIP_DRIFT");
  if (!e.aclIsExplicit) return result("BLOCKED", "DIRECT_ACL_UNAVAILABLE");
  const expectedNames = [
    ...contract.roles.map((r) => r.name),
    "pg_database_owner",
  ].sort();
  if (!same(e.roles.map((r) => r.name).sort(), expectedNames))
    return result("BLOCKED", "ROLE_INVENTORY_UNAVAILABLE");
  for (const r of contract.roles) {
    const live = e.roles.find((x) => x.name === r.name);
    if (!roleFields.every((k) => live[k] === r[k]))
      return result("CONFLICT", "ROLE_ATTRIBUTE_DRIFT");
  }
  const owner = e.roles.find((r) => r.name === "pg_database_owner");
  if (
    owner.login ||
    owner.super ||
    owner.bypass ||
    owner.createRole ||
    owner.createDb ||
    owner.replication
  )
    return result("CONFLICT", "OWNER_ROLE_ATTRIBUTE_DRIFT");
  const expectedMembers = contract.memberships.map((m) => ({
    ...m,
    grantor: "postgres",
  }));
  const serialMembers = (rows) =>
    rows.map((r) => JSON.stringify(memberFields.map((k) => r[k]))).sort();
  if (!same(serialMembers(e.memberships), serialMembers(expectedMembers)))
    return result("CONFLICT", "MEMBERSHIP_DRIFT");
  if (!same(e.effective.map((r) => r.name).sort(), expectedNames))
    return result("BLOCKED", "EFFECTIVE_MATRIX_INCOMPLETE");
  for (const r of e.effective) {
    const isOwner = ["postgres", "pg_database_owner"].includes(r.name);
    if (
      !r.usage ||
      r.create !== isOwner ||
      r.ownerMember !== isOwner ||
      r.ownerUsage !== isOwner ||
      r.ownerSet !== isOwner
    )
      return result("CONFLICT", "EFFECTIVE_AUTHORITY_DRIFT");
  }
  const baseline = [
    {
      grantee: "pg_database_owner",
      grantor: "pg_database_owner",
      privilege: "USAGE",
      grantable: false,
    },
    {
      grantee: "pg_database_owner",
      grantor: "pg_database_owner",
      privilege: "CREATE",
      grantable: false,
    },
    {
      grantee: "PUBLIC",
      grantor: "pg_database_owner",
      privilege: "USAGE",
      grantable: false,
    },
  ];
  const residual = e.acl.filter((r) => !affected.includes(r.grantee));
  const serialAcl = (rows) =>
    rows.map((r) => JSON.stringify(aclFields.map((k) => r[k]))).sort();
  if (!same(serialAcl(residual), serialAcl(baseline)))
    return result("CONFLICT", "PUBLIC_ACL_BASELINE_DRIFT");
  const entries = {};
  for (const name of affected) {
    const rows = e.acl.filter((r) => r.grantee === name);
    if (
      rows.length !== 1 ||
      rows[0].privilege !== "USAGE" ||
      rows[0].grantable ||
      !["postgres", "pg_database_owner"].includes(rows[0].grantor)
    )
      entries[name] = { status: "CONFLICT", reason: "DIRECT_GRANT_DRIFT" };
    else if (rows[0].grantor === "postgres")
      entries[name] = { status: "PASS", reason: "EXACT_PINNED_PROVENANCE" };
    else
      entries[name] = {
        status: "BLOCKED",
        reason: "OWNER_AUTHORITY_DEMONSTRATED_CONTRACT_REVIEW_REQUIRED",
      };
  }
  const statuses = Object.values(entries).map((r) => r.status);
  const status = statuses.includes("CONFLICT")
    ? "CONFLICT"
    : statuses.includes("BLOCKED")
      ? "BLOCKED"
      : "PASS";
  return result(status, "TARGETED_PUBLIC_ACL_ONLY", entries);
}
