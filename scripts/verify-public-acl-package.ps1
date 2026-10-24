# Offline verification launcher only. Deliberately cannot execute the inspection.
param(
  [Parameter(Mandatory)][string]$PackageRoot,
  [Parameter(Mandatory)][string]$ManifestHash,
  [Parameter(Mandatory)][string]$NodeExecutable,
  [Parameter(Mandatory)][string]$NodeHash
)
$ErrorActionPreference = 'Stop'
try {
  if ((Split-Path $PSScriptRoot) -ine $PackageRoot.TrimEnd('\')) { throw 'PF_TRUSTED_PATHS' }
  . (Join-Path $PSScriptRoot 'public-acl-package-trust.ps1')
  Assert-PublicAclPackage $PackageRoot $ManifestHash $NodeExecutable $NodeHash
  Write-Output 'PASS: Offline package verified; execution remains unauthorized.'
} catch {
  Write-Output 'BLOCKED: PF_TRUSTED_PACKAGE'
  exit 1
}
