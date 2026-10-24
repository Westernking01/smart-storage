$ErrorActionPreference='Stop'
$runName='smart-storage-provider-p14b-20261011-c40e8e03'
$runDirectory=[IO.Path]::GetFullPath((Join-Path $env:USERPROFILE $runName))
if ((Split-Path -Leaf $runDirectory) -ne $runName -or ((Get-Item -LiteralPath $runDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected target' }
$children=@(Get-ChildItem -LiteralPath $runDirectory -Force)
if (Test-Path -LiteralPath (Join-Path $runDirectory 'lock')) { throw 'Existing lock: stop without clearing' }
if (Test-Path -LiteralPath (Join-Path $runDirectory 'pending')) { throw 'Incomplete commit: stop' }
foreach ($child in $children) { if ($child.PSIsContainer -or $child.Name -notin @('marker','journal','snapshot') -or ($child.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected state artifact' } }
if ($children.Count -ne 3) { throw 'Missing ledger artifact' }
$currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$unwantedSid='S-1-5-21-3058023354-1746979206-3201508519-1002'
$targets=@($runDirectory)+@($children.FullName)
$beforeHashes=@{}
foreach ($child in $children) { $beforeHashes[$child.Name]=(Get-FileHash -LiteralPath $child.FullName -Algorithm SHA256).Hash }
foreach ($target in $targets) {
 $acl=Get-Acl -LiteralPath $target
 $owner=([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value
 if ($owner -ne $currentSid.Value) { throw 'Unexpected owner' }
 foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($rule.IdentityReference.Value -notin @($currentSid.Value,$systemSid.Value,$unwantedSid) -or $rule.AccessControlType -ne 'Allow') { throw 'Unexpected ACL: stop' }
  if ($rule.IdentityReference.Value -eq $unwantedSid -and $rule.FileSystemRights.ToString() -ne 'ReadAndExecute, Synchronize') { throw 'Unexpected group rights: stop' }
 }
}
foreach ($target in $targets) {
 $isDirectory=[IO.Directory]::Exists($target)
 if ($isDirectory) {$acl=[IO.Directory]::GetAccessControl($target,[Security.AccessControl.AccessControlSections]::Access)} else {$acl=[IO.File]::GetAccessControl($target,[Security.AccessControl.AccessControlSections]::Access)}
 $acl.SetAccessRuleProtection($true,$false)
 foreach ($rule in @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))) {$acl.RemoveAccessRuleSpecific($rule)}
 foreach ($principal in @($currentSid,$systemSid)) {
  if ($isDirectory) {$rule=[Security.AccessControl.FileSystemAccessRule]::new($principal,'FullControl',[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)} else {$rule=[Security.AccessControl.FileSystemAccessRule]::new($principal,'FullControl',[Security.AccessControl.AccessControlType]::Allow)}
  $acl.AddAccessRule($rule)
 }
 if ($isDirectory) {[IO.Directory]::SetAccessControl($target,$acl)} else {[IO.File]::SetAccessControl($target,$acl)}
}
foreach ($child in $children) { if ($beforeHashes[$child.Name] -ne (Get-FileHash -LiteralPath $child.FullName -Algorithm SHA256).Hash) {throw 'Ledger bytes changed during ACL repair'} }
Write-Output '{"aclCorrected":true,"ledgerBytesPreservedDuringRepair":true,"providerRequests":0}'
