# Nonsecret transcription only. No manifests, credentials, SQL or network I/O.
$ErrorActionPreference = 'Stop'
$probeEvidenceDirectory = 'C:\Users\Admin\Desktop\NEW\smart-storage-probe-evidence'
$probeEvidencePath = Join-Path $probeEvidenceDirectory 'seeded-probe-operator-evidence-v1.json'
$probeRecord = [ordered]@{
  recordId = 'smart-storage-seeded-probe-operator-evidence-v1'
  recordCreatedAtUtc = [DateTime]::UtcNow.ToString('o')
  sourceObservationTimestamp = $null
  provenance = 'Operator-provided results transcribed from this task and docs/seeded-probe-operator.md; not a new independent provider, fixture or ACL verification. Creation time is not observation time.'
  sourceDocumentation = 'C:\Users\Admin\Desktop\NEW\smart-storage\docs\seeded-probe-operator.md'
  references = [ordered]@{
    policyReview = 'seeded-probe-operator-evidence-v1.json#policyReview'
    fixtureVerification = 'seeded-probe-operator-evidence-v1.json#fixtureVerification'
    directoryEvidence = 'seeded-probe-operator-evidence-v1.json#directoryEvidence'
  }
  policyReview = [ordered]@{
    provenance = 'Operator-confirmed deployed SQL output; expression text reviewed locally; no new provider contact.'
    project = 'rrylhvqalsxjnkdkpwde'
    userId = '310d0ec8-84ca-423a-b646-0480a20edc09'
    objectsRlsEnabled = $true
    objectsRlsForced = $false
    objectsPolicies = @([ordered]@{
      name = 'smart_storage_probe_read_only'
      permissive = 'PERMISSIVE'
      command = 'SELECT'
      roles = @('authenticated')
      usingExpression = "((auth.uid() = '310d0ec8-84ca-423a-b646-0480a20edc09'::uuid) AND (bucket_id = 'smart-storage-gateway-probe'::text) AND (name = 'gateway-probe/v1/probe-fixture-v1.txt'::text))"
      withCheckOutput = $null
      withCheckNote = 'Not supplied in the transcribed source; null here is not a claimed catalog result.'
    })
    bucketsPolicies = @()
    tablePrivileges = [ordered]@{
      tables = @('storage.objects', 'storage.buckets')
      roles = @('anon', 'authenticated', 'service_role')
      privileges = @('SELECT', 'INSERT', 'UPDATE', 'DELETE')
      limitation = 'Reported table grants; effective access depends on RLS and API behavior.'
    }
    roleAttributes = @(
      [ordered]@{ role = 'anon'; rolbypassrls = $false; rolsuper = $false },
      [ordered]@{ role = 'authenticated'; rolbypassrls = $false; rolsuper = $false },
      [ordered]@{ role = 'service_role'; rolbypassrls = $true; rolsuper = $false }
    )
    checkedMemberships = @(
      [ordered]@{ member = 'anon'; targets = @('authenticated', 'postgres', 'service_role'); is_member = $false; can_use_privileges = $false },
      [ordered]@{ member = 'authenticated'; targets = @('anon', 'postgres', 'service_role'); is_member = $false; can_use_privileges = $false }
    )
    membershipScope = 'Operator reports checked transitive memberships. Exact query text not supplied; no claim about unreported role targets.'
    bucket = 'smart-storage-gateway-probe'
    bucketPublic = $false
    localExpressionReview = 'Three exact equality predicates joined by AND, explicit uuid/text casts, no OR branch; configuration evidence only.'
    effectiveStorageApiBehavior = 'UNVERIFIED'
    noBroaderEffectiveAccessAcknowledged = $false
    noWriteOrAdministrativeAccessAcknowledged = $false
  }
  fixtureVerification = [ordered]@{
    provenance = 'Original local fixture independently checked by operator; not rehashed or read by the tool.'
    storageKey = 'gateway-probe/v1/probe-fixture-v1.txt'
    originalLocalFixturePath = $null
    originalLocalFixturePathNote = 'Not supplied; storage key is not the local source path.'
    bytes = 123
    sha256 = '57d60b8f171ecb27ee614e0a518b3bfba7d8c994bb4daf20c496818970d4c511'
    remoteBytesVerified = $false
  }
  directoryEvidence = [ordered]@{
    provenance = 'Operator-reported ACL and directory/ancestor attributes, not independently reverified by this writer.'
    path = $probeEvidenceDirectory
    onlyReportedAclIdentities = @('Administrators', 'SYSTEM', 'DESKTOP-G12NE65\Admin')
    reportedAccess = 'FullControl'
    directoryAndAncestorsReparseIndicators = $false
    ownerVerified = $false
    ownerAcknowledged = $false
    owner = $null
  }
  localCreationObservation = [ordered]@{
    executionIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    method = 'CreateNew in existing directory, write UTF-8 JSON, flush to disk. A returned success establishes this identity could create this file, not general future claim-file availability.'
    independentVerificationScope = 'Local record creation only; no ACL/owner/ancestor, fixture or Supabase recheck.'
  }
  boundaries = [ordered]@{
    isApproval = $false
    executionManifestsModified = $false
    adr041 = 'Unresolved'
    cloudTransfersEnabled = $false
    screenshotPaths = @()
  }
}
$probeJson = $probeRecord | ConvertTo-Json -Depth 12
$probeBytes = [Text.UTF8Encoding]::new($false).GetBytes($probeJson + [Environment]::NewLine)
$probeStream = $null
try {
  # Never overwrite an existing evidence record or create/repair the directory.
  $probeStream = [IO.File]::Open($probeEvidencePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $probeStream.Write($probeBytes, 0, $probeBytes.Length)
  $probeStream.Flush($true)
} finally {
  if ($null -ne $probeStream) { $probeStream.Dispose() }
}
Write-Output "CREATED: $probeEvidencePath"
Write-Output "Creation identity: $($probeRecord.localCreationObservation.executionIdentity)"
