# Synthetic ACL metadata and disposable local file-link fixtures only.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'public-acl-package-trust.ps1')
$sid = 'S-1-5-21-3058023354-1746979206-3201508519-1000'
$script:passed = 0
function Expect-Rejection([scriptblock]$Action) {
  $blocked = $false
  try { & $Action } catch { if ($_.Exception.Message -notmatch '^PF_') { throw }; $blocked=$true }
  if (-not $blocked) { throw 'Expected rejection' }
  $script:passed++
}
function New-Descriptor([string]$Owner=$sid,[bool]$Protected=$true,[string]$Trustee=$sid,[bool]$Inherited=$false,[int]$Rights=2032127) {
  $value = [pscustomobject]@{ OwnerSid=$Owner; AreAccessRulesProtected=$Protected; AreAccessRulesCanonical=$true; Rules=@([pscustomobject]@{AccessControlType='Allow'; PropagationFlags=0; FileSystemRights=[Enum]::ToObject([Security.AccessControl.FileSystemRights],$Rights); IdentityReference=@{Value=$Trustee}; IsInherited=$Inherited}) }
  $value | Add-Member ScriptMethod GetOwner {param($type) @{Value=$this.OwnerSid}}
  $value | Add-Member ScriptMethod GetSecurityDescriptorSddlForm {param($sections) 'D:P(A;;FA;;;SY)'}
  $value | Add-Member ScriptMethod GetAccessRules {param($explicit,$inherited,$type) $this.Rules}
  $value
}
Assert-AclPackageIdentity $sid $true
Assert-AclPackageDescriptor (New-Descriptor) $true $sid
Assert-AclPackageHash ('a'*64) ('a'*64)
$script:passed += 3
# Package sole-Allow policy includes trusted system principals and read-only or
# inherit-only entries. The separate runtime/ancestor policy must still pass.
foreach ($principal in @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464','S-1-5-21-999')) {
  foreach ($rights in @(2032127,131209)) {
    Expect-Rejection { Assert-AclPackageDescriptor (New-Descriptor -Trustee $principal -Rights $rights) $true $sid }
  }
  Expect-Rejection {
    $descriptor = New-Descriptor -Trustee $principal
    $descriptor.Rules[0].PropagationFlags = [Security.AccessControl.PropagationFlags]::InheritOnly
    Assert-AclPackageDescriptor $descriptor $true $sid
  }
  if ($principal -ne 'S-1-5-21-999') {
    Assert-AclPackageDescriptor (New-Descriptor -Owner $principal -Trustee $principal) $true $sid $false
    Assert-AclPackageDescriptor (New-Descriptor -Owner $principal -Trustee $principal -Protected $false -Inherited $true) $false $sid
    $script:passed += 2
  }
}
Expect-Rejection { Assert-AclPackageDescriptor (New-Descriptor -Inherited $true) $true $sid }
Expect-Rejection {
  $descriptor = New-Descriptor
  $descriptor.AreAccessRulesCanonical = $false
  Assert-AclPackageDescriptor $descriptor $true $sid
}
$deny = New-Descriptor -Trustee 'S-1-5-18'
$deny.Rules[0].AccessControlType = 'Deny'
Assert-AclPackageDescriptor $deny $true $sid
$script:passed++
Expect-Rejection { Assert-AclPackageIdentity 'S-1-5-18' $true }
Expect-Rejection { Assert-AclPackageIdentity $sid $false }
Expect-Rejection { Assert-AclPackageHash ('a'*64) ('b'*64) }
Expect-Rejection { Assert-AclPackageHash ('a'*64) 'unpinned' }
Expect-Rejection { Assert-AclPackageDescriptor (New-Descriptor -Owner 'S-1-5-18') $true $sid }
Expect-Rejection { Assert-AclPackageDescriptor (New-Descriptor -Protected $false) $true $sid }
Expect-Rejection { Assert-AclPackageDescriptor (New-Descriptor -Trustee 'S-1-5-21-999' -Inherited $true) $true $sid }
Expect-Rejection { Assert-AclPackageDescriptor (New-Descriptor -Trustee 'S-1-5-21-999') $true $sid }
Expect-Rejection { Assert-AclPackageDescriptor (New-Descriptor -Trustee 'S-1-5-21-999' -Rights 64) $false $sid }
Expect-Rejection { Assert-AclPackageDescriptor (New-Descriptor -Trustee 'S-1-5-21-999' -Rights 0x10000000) $false $sid }
Expect-Rejection {
  $nullDacl = New-Descriptor
  $nullDacl | Add-Member -Force ScriptMethod GetSecurityDescriptorSddlForm {param($sections) 'D:NO_ACCESS_CONTROL'}
  Assert-AclPackageDescriptor $nullDacl $false $sid
}
foreach ($invalid in @('node.exe','\\server\node.exe','C:\temp\..\node.exe','C:\node.exe:stream','C:\temp.\node.exe')) {
  Expect-Rejection { Assert-AclPackagePath $invalid }
}
# Native offline NTFS tests: ordinary hard links are not reparse points.
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('acl-links-' + [Guid]::NewGuid().ToString('N'))
$ordinary = $fixture + '.txt'
$alias = $fixture + '.link.txt'
try {
  [IO.File]::WriteAllText($ordinary, 'offline fixture')
  Assert-AclPackageSingleLink $ordinary
  $script:passed++
  New-Item -ItemType HardLink -Path $alias -Target $ordinary -ErrorAction Stop | Out-Null
  if ((Get-Item -LiteralPath $ordinary).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Invalid hard-link fixture' }
  Expect-Rejection { Assert-AclPackageSingleLink $ordinary }
  Expect-Rejection { Assert-AclPackageSingleLink $alias }
  Expect-Rejection { Assert-AclPackageSingleLink ($fixture + '.missing') }
} finally {
  foreach ($file in @($alias,$ordinary)) {
    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
  }
}
# Unavailable, malformed and zero metadata must never become a single link.
foreach ($metadata in @($null, [uint32]0, '1', @([uint32]1,[uint32]1))) {
  function Get-AclPackageLinkCount {param($Path) $metadata}
  Expect-Rejection { Assert-AclPackageSingleLink 'C:\synthetic.txt' }
}
function Get-AclPackageLinkCount {param($Path) throw 'Sensitive native error/path must not escape'}
Expect-Rejection { Assert-AclPackageSingleLink 'C:\synthetic.txt' }
# The shared walker must check launcher, helper, manifest and other files before ACLs.
function Get-Item {param($LiteralPath,[switch]$Force,$ErrorAction) @{Attributes=[IO.FileAttributes]::Normal}}
foreach ($file in @('verify-public-acl-package.ps1','public-acl-package-trust.ps1','public-acl-package.manifest.json','host.mjs')) {
  Expect-Rejection { Assert-AclPackageTreePath ("C:\TrustedAcl\scripts\" + $file) 'C:\TrustedAcl' $sid }
}
# Substitute only identity/path metadata for orchestration rejection tests.
function Assert-AclPackageIdentity {param($Sid,$Elevated)}
Expect-Rejection { Assert-PublicAclPackage 'C:\TrustedAcl' ('a'*64) 'C:\Users\Admin\node.exe' ('b'*64) }
Expect-Rejection { Assert-PublicAclPackage 'C:\Users\Admin\Desktop\NEW\copy' ('a'*64) 'C:\Program Files\nodejs\node.exe' ('b'*64) }
# No Get-Acl executes: path walker sees synthetic reparse metadata first.
function Get-Item {param($LiteralPath,[switch]$Force,$ErrorAction) @{Attributes=[IO.FileAttributes]::ReparsePoint}}
Expect-Rejection { Assert-AclPackageTreePath 'C:\TrustedAcl\host.mjs' 'C:\TrustedAcl' $sid }
Write-Output "PASS: $script:passed offline trust assertions."
