// Fixed offline report generator: no driver, credentials, subprocesses or network.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  loadPredecessorContracts,
  comparePredecessorCatalog,
} from "./predecessor-contracts.mjs";
const root = path.resolve(import.meta.dirname, "..");
const source =
  "docs/disposable-qualification-catalog-report.20261022-contract-verification.json";
const bytes = await fs.readFile(path.join(root, source), "utf8");
const historical = JSON.parse(bytes);
const contract = await loadPredecessorContracts();
// Historical aggregate statuses cannot be substituted for catalog rows.
const missing = comparePredecessorCatalog(contract, { version: 1 });
const report = {
  version: 1,
  mode: "OFFLINE_RETAINED_SUMMARY_ONLY",
  status: "BLOCKED",
  adr041: "OPEN",
  transfersEnabled: false,
  liveAccessPerformed: false,
  source: {
    path: source,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    inspection: historical.inspection,
    target: historical.target,
    catalogDigest: historical.catalogDigest,
  },
  historicalChecks: Object.fromEntries(
    ["constraints", "triggers", "ACLs"].map((k) => [
      k,
      historical.predecessorContracts.checks[k],
    ]),
  ),
  rules: {
    constraints:
      "Exact normalized multiset of table/kind/ordered columns/definition/validation/deferrability/CHECK NO INHERIT/FK actions; explicit names independently fenced. Anonymous identity uses contract ordinal.",
    triggers:
      "Exact table/name/enabled/definition token multiset; only final semicolon normalization added.",
    ACLs: "Exact expanded kind/object/grantee/privilege/grantable/grantor multiset, including duplicates. Effective privileges are a separate gate.",
  },
  classifications: {
    genuineLiveMismatches: [],
    provenUnsupportedLiveRenderings: [],
    provenLiveNormalizationDifferences: [],
    incompleteRetainedEvidence: [
      "constraints rows",
      "triggers rows",
      "expanded grants rows",
    ],
    warning:
      "Empty classified lists mean unproven, not absent. Aggregate mismatches are historical facts; no failing live object can be identified from this summary.",
  },
  diagnostics: missing.diagnostics,
  needsNewReadOnlyInspection: true,
  requiredEvidence: [
    "In-memory complete predecessor_catalog consumed by the instrumented comparator; retain sanitized per-object diagnostics before disposal.",
    "Constraint field differences and unsupported expression digests; trigger identity/enabled/definition differences; expanded ACL principal/privilege/grant-option/grantor differences.",
  ],
  migrations012Through014: "BLOCKED",
  qualificationReady: false,
  nextAction:
    "Review offline diagnostics, then separately authorize one fresh bounded read-only inspection with a new one-use fence. Do not invoke either existing inspector or reuse consumed fences.",
};
await fs.writeFile(
  path.join(root, "docs/offline-predecessor-diagnostics-report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  "PASS: offline sanitized diagnostic report generated; compatibility BLOCKED.",
);
