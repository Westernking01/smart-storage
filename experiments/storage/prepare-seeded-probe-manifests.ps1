# Operator-only local evidence validation and disabled manifest preparation.
# No network, credentials, approval generation, ACL changes or probe execution.
$ErrorActionPreference = 'Stop'
$probeRoot = 'C:\Users\Admin\Desktop\NEW\smart-storage'
$probeDirectory = 'C:\Users\Admin\Desktop\NEW\smart-storage-probe-evidence'
$probeEvidencePath = Join-Path $probeDirectory 'seeded-probe-operator-evidence-v1.json'
function Assert-ProbeFact($condition, [string]$message) {
  if (-not $condition) { throw "Evidence validation failed: $message" }
}
function Assert-ProbeSet($actual, $expected, [string]$message) {
  Assert-ProbeFact ((@($actual).Count -eq @($expected).Count) -and
    ((@($actual | Sort-Object) -join '|') -ceq (@($expected | Sort-Object) -join '|'))) $message
}
$probeEvidence = [IO.File]::ReadAllText($probeEvidencePath) | ConvertFrom-Json
$probeRefs = $probeEvidence.references
foreach ($probePair in @(@('policyReview','policyReview'), @('fixtureVerification','fixtureVerification'), @('directoryEvidence','directoryEvidence'))) {
  $probeValue = $probeRefs.($probePair[0])
  Assert-ProbeFact ($probeValue -is [string]) ('Missing reference: ' + $probePair[0])
  $probeParts = $probeValue.Split('#')
  Assert-ProbeFact ($probeParts.Count -eq 2 -and $probeParts[0] -ceq 'seeded-probe-operator-evidence-v1.json' -and $probeParts[1] -ceq $probePair[1]) ('Unexpected reference: ' + $probeValue)
  Assert-ProbeFact ($null -ne $probeEvidence.($probeParts[1])) ('Unresolved section: ' + $probeValue)
}
$probePolicy = $probeEvidence.policyReview
$probeFixture = $probeEvidence.fixtureVerification
$probeDir = $probeEvidence.directoryEvidence
Assert-ProbeFact ($probeEvidence.recordId -ceq 'smart-storage-seeded-probe-operator-evidence-v1') 'Record ID'
Assert-ProbeFact ($probeEvidence.provenance -is [string] -and $probeEvidence.provenance.Length -gt 0) 'Provenance'
Assert-ProbeFact ($probePolicy.project -ceq 'rrylhvqalsxjnkdkpwde') 'Project'
Assert-ProbeFact ($probePolicy.userId -ceq '310d0ec8-84ca-423a-b646-0480a20edc09') 'UID'
Assert-ProbeFact ($probePolicy.objectsRlsEnabled -ceq $true -and $probePolicy.objectsRlsForced -ceq $false) 'Objects RLS'
Assert-ProbeFact (@($probePolicy.objectsPolicies).Count -eq 1 -and @($probePolicy.bucketsPolicies).Count -eq 0) 'Policy inventory'
$probeRow = $probePolicy.objectsPolicies[0]
Assert-ProbeFact ($probeRow.name -ceq 'smart_storage_probe_read_only' -and $probeRow.permissive -ceq 'PERMISSIVE' -and $probeRow.command -ceq 'SELECT') 'Policy identity'
Assert-ProbeSet $probeRow.roles @('authenticated') 'Policy roles'
$probePredicate = "((auth.uid() = '310d0ec8-84ca-423a-b646-0480a20edc09'::uuid) AND (bucket_id = 'smart-storage-gateway-probe'::text) AND (name = 'gateway-probe/v1/probe-fixture-v1.txt'::text))"
Assert-ProbeFact ($probeRow.usingExpression -ceq $probePredicate) 'Complete predicate'
Assert-ProbeSet $probePolicy.tablePrivileges.tables @('storage.objects','storage.buckets') 'Grant tables'
Assert-ProbeSet $probePolicy.tablePrivileges.roles @('anon','authenticated','service_role') 'Grant roles'
Assert-ProbeSet $probePolicy.tablePrivileges.privileges @('SELECT','INSERT','UPDATE','DELETE') 'Grant privileges'
Assert-ProbeSet @($probePolicy.roleAttributes | ForEach-Object { $_.role }) @('anon','authenticated','service_role') 'Role attributes inventory'
foreach ($probeRole in $probePolicy.roleAttributes) {
  Assert-ProbeFact ($probeRole.rolsuper -ceq $false) 'Role superuser flag'
  Assert-ProbeFact ($probeRole.rolbypassrls -ceq ($probeRole.role -ceq 'service_role')) 'Role bypass flag'
}
Assert-ProbeSet @($probePolicy.checkedMemberships | ForEach-Object { $_.member }) @('anon','authenticated') 'Membership inventory'
foreach ($probeMembership in $probePolicy.checkedMemberships) {
  $probeOther = if ($probeMembership.member -ceq 'anon') { 'authenticated' } else { 'anon' }
  Assert-ProbeSet $probeMembership.targets @($probeOther,'postgres','service_role') 'Membership targets'
  Assert-ProbeFact ($probeMembership.is_member -ceq $false -and $probeMembership.can_use_privileges -ceq $false) 'Membership results'
}
Assert-ProbeFact ($probePolicy.bucket -ceq 'smart-storage-gateway-probe' -and $probePolicy.bucketPublic -ceq $false) 'Private bucket'
Assert-ProbeFact ($probeFixture.storageKey -ceq 'gateway-probe/v1/probe-fixture-v1.txt' -and $probeFixture.bytes -eq 123 -and $probeFixture.sha256 -ceq '57d60b8f171ecb27ee614e0a518b3bfba7d8c994bb4daf20c496818970d4c511') 'Fixture scope/bytes/hash'
Assert-ProbeFact ($probeDir.path -ceq $probeDirectory) 'Evidence directory'
Assert-ProbeSet $probeDir.onlyReportedAclIdentities @('Administrators','SYSTEM','DESKTOP-G12NE65\Admin') 'Reported ACL identities'
Assert-ProbeFact ($probeDir.reportedAccess -ceq 'FullControl' -and $probeDir.directoryAndAncestorsReparseIndicators -ceq $false) 'Reported ACL/ancestor findings'
Assert-ProbeFact ($probePolicy.effectiveStorageApiBehavior -ceq 'UNVERIFIED' -and $probeFixture.remoteBytesVerified -ceq $false) 'Unverified API state'
Assert-ProbeFact ($probePolicy.noBroaderEffectiveAccessAcknowledged -ceq $false -and $probePolicy.noWriteOrAdministrativeAccessAcknowledged -ceq $false) 'No unsupported effective-access acknowledgment'
Assert-ProbeFact ($probeEvidence.boundaries.isApproval -ceq $false -and $probeEvidence.boundaries.cloudTransfersEnabled -ceq $false -and $probeEvidence.boundaries.executionManifestsModified -ceq $false) 'Original record boundaries'

# Read only the five public repository templates. Keep approvals absent.
$probeTemplates = @{
  PLAN = 'disposable-probe.auth.template.json'
  REVIEW = 'disposable-probe.permissions.template.json'
  CONFIG = 'disposable-probe.config.template.json'
  AUTH_APPROVAL = 'disposable-probe.auth-authorization.template.json'
  STORAGE_APPROVAL = 'disposable-probe.authorization.template.json'
}
$probeManifests = @{}
$probeOutputs = [ordered]@{}
foreach ($probeKind in @('PLAN','REVIEW','CONFIG','AUTH_APPROVAL','STORAGE_APPROVAL')) {
  $probeTemplatePath = Join-Path (Join-Path $probeRoot 'experiments\storage') $probeTemplates[$probeKind]
  $probeManifest = [IO.File]::ReadAllText($probeTemplatePath) | ConvertFrom-Json
  if ($null -ne $probeManifest.PSObject.Properties['enabled']) { $probeManifest.enabled = $false }
  if ($null -ne $probeManifest.PSObject.Properties['authorizationId']) {
    $probeManifest.authorizationId = $null; $probeManifest.issuedAt = $null; $probeManifest.expiresAt = $null
    $probeManifest.physicalOverheadUnboundedAcknowledged = $false
  }
  $probeManifests[$probeKind] = $probeManifest
  $probeOutputs[$probeKind] = Join-Path $probeDirectory ("seeded-probe-prepared-v1.$probeKind.json")
}
$probeReview = $probeManifests.REVIEW
$probeReview.reviewReference = $probeRefs.policyReview
$probeReview.noBroaderEffectiveAccess = $false
$probeReview.noWriteOrAdministrativeAccess = $false
foreach ($probeKind in @('CONFIG','STORAGE_APPROVAL')) {
  $probeManifests[$probeKind].independentFixtureVerification = $probeRefs.fixtureVerification
  $probeManifests[$probeKind].destinations.restrictedAclReviewed = $false
}
$probeManifests.AUTH_APPROVAL.restrictedAclReviewed = $false
$probeReportPath = Join-Path $probeDirectory 'seeded-probe-prepared-v1.validation.json'
# All collision checks happen before any writes; CreateNew also guards races.
foreach ($probeOutput in @($probeOutputs.Values) + @($probeReportPath)) {
  Assert-ProbeFact (-not [IO.File]::Exists($probeOutput)) ('Output already exists; preserve and report: ' + $probeOutput)
}
$probeReport = [ordered]@{
  result = 'PASS local evidence JSON, exact references and three-section consistency checks; not independent verification of reported Supabase/fixture/ACL facts'
  evidencePath = $probeEvidencePath
  actualReferences = $probeRefs
  preparedManifestPaths = $probeOutputs
  ownershipFindings = [ordered]@{
    provenance = 'Operator-confirmed in the current task; no new owner/ACL check'
    directoryOwner = 'BUILTIN\Administrators'
    evidenceFileOwner = 'DESKTOP-G12NE65\Admin'
    evidenceCreationIdentity = 'DESKTOP-G12NE65\Admin'
    reportedEvidenceBytes = 9899
    ownerAcknowledgment = 'INCOMPLETE: factual ownership report is not an execution ACL-review acknowledgment'
  }
  originalEvidenceModified = $false
  effectiveStorageApiBehavior = 'UNVERIFIED'
  approvalRecords = 'ABSENT; UUIDs/times null, enable flags false, accounting acknowledgment false'
  remainingRequirements = @('Explicit supported effective-access review acknowledgments', 'Explicit directory ACL/owner acknowledgment', 'Genuine separate fresh Auth and Storage approvals and accepted-body/unbounded-overhead acknowledgment for shared dry-run preflight; not authorized here', 'Separate local registration authorization before execution')
}
$probeWriteSet = [ordered]@{}
foreach ($probeKind in $probeOutputs.Keys) { $probeWriteSet[$probeOutputs[$probeKind]] = $probeManifests[$probeKind] }
$probeWriteSet[$probeReportPath] = $probeReport
foreach ($probeOutput in $probeWriteSet.Keys) {
  $probeBytes = [Text.UTF8Encoding]::new($false).GetBytes(($probeWriteSet[$probeOutput] | ConvertTo-Json -Depth 14) + [Environment]::NewLine)
  $probeStream = $null
  try {
    $probeStream = [IO.File]::Open($probeOutput, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $probeStream.Write($probeBytes, 0, $probeBytes.Length); $probeStream.Flush($true)
  } finally { if ($null -ne $probeStream) { $probeStream.Dispose() } }
}
$probeReport | ConvertTo-Json -Depth 14
# On any partial write/failure, preserve outputs; do not rerun/delete automatically.
