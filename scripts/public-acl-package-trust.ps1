# Read-only trust primitives. No credentials, fences, process queries or execution.
function Assert-AclPackagePath([string]$Path) {
  if ($Path -cnotmatch '^[A-Za-z]:\\' -or $Path -match '["~*?<>|\x00-\x1f]' -or $Path.Substring(2).Contains(':') -or $Path -match '[. ](\\|$)') { throw 'PF_TRUSTED_PATHS' }
  $full = [IO.Path]::GetFullPath($Path)
  if ($full.TrimEnd('\') -ine $Path.TrimEnd('\')) { throw 'PF_TRUSTED_PATHS' }
  $full
}
function Assert-AclPackageDescriptor($Descriptor, [bool]$Protected, [string]$Sid, [bool]$OperatorOwner = $true) {
  $system = 'S-1-5-18'; $admins = 'S-1-5-32-544'
  if ($Descriptor.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -match 'NO_ACCESS_CONTROL') { throw 'PF_TRUSTED_PATHS' }
  $owner = $Descriptor.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($Protected) {
    if (($OperatorOwner -and $owner -cne $Sid) -or -not $Descriptor.AreAccessRulesProtected) { throw 'PF_TRUSTED_PATHS' }
    if (-not $OperatorOwner -and $owner -cnotin @($Sid,$system,$admins,'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) { throw 'PF_TRUSTED_PATHS' }
  } elseif ($owner -cnotin @($Sid,$system,$admins,'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) { throw 'PF_TRUSTED_PATHS' }
  if (-not $Descriptor.AreAccessRulesCanonical) { throw 'PF_TRUSTED_PATHS' }
  foreach ($ace in $Descriptor.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($Protected -and $ace.IsInherited) { throw 'PF_TRUSTED_PATHS' }
    # Package contents have exactly one permitted Allow principal, regardless
    # of rights or inherit-only scope. Runtime and ancestor policy is separate.
    if ($Protected -and $OperatorOwner -and $ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Value -cne $Sid) { throw 'PF_TRUSTED_PATHS' }
    if ($ace.AccessControlType -ne 'Allow' -or ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
    # Write data/create, append/create-directory, EA, delete-child, attributes,
    # delete, change-DACL and take-ownership. Deny ACEs never justify an Allow.
    if ((($ace.FileSystemRights.value__ -band 0xD0156) -or ($ace.FileSystemRights.value__ -band 0x50000000)) -and $ace.IdentityReference.Value -cnotin @($Sid,$system,$admins,'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) { throw 'PF_TRUSTED_PATHS' }
  }
}
function Get-AclPackageLinkCount([string]$Path) {
  # Query the open file, not PowerShell LinkType or reparse attributes: ordinary
  # NTFS hard links have neither. No localized command output is parsed.
  if (-not ('SmartStorageAcl.NativeFileLinks' -as [type])) {
    Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace SmartStorageAcl {
  public static class NativeFileLinks {
    [StructLayout(LayoutKind.Sequential)]
    private struct Information {
      public uint Attributes;
      public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
      public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out Information info);
    public static uint Count(string path) {
      using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
        Information info;
        if (!GetFileInformationByHandle(file.SafeFileHandle, out info) ||
            (info.Attributes & (0x10u | 0x400u)) != 0 || info.Links == 0)
          throw new IOException("File metadata unavailable");
        return info.Links;
      }
    }
  }
}
'@ | Out-Null
  }
  [SmartStorageAcl.NativeFileLinks]::Count($Path)
}
function Assert-AclPackageSingleLink([string]$Path) {
  try {
    $count = Get-AclPackageLinkCount $Path
    if ($count -isnot [uint32] -or $count -ne 1) { throw 'Unavailable or multiple links' }
  } catch { throw 'PF_TRUSTED_PATHS' }
}
function Assert-AclPackageTreePath([string]$Path, [string]$Boundary, [string]$Sid, [bool]$OperatorOwner = $true) {
  $cursor = Assert-AclPackagePath $Path
  while ($cursor) {
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'PF_TRUSTED_PATHS' }
    if (-not ($item.Attributes -band [IO.FileAttributes]::Directory)) { Assert-AclPackageSingleLink $cursor }
    $inside = $cursor -ieq $Boundary -or $cursor.StartsWith($Boundary.TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase)
    Assert-AclPackageDescriptor (Get-Acl -LiteralPath $cursor -ErrorAction Stop) $inside $Sid $OperatorOwner
    $cursor = Split-Path $cursor
  }
}
function Assert-AclPackageIdentity([string]$Sid, [bool]$Elevated) {
  if ($Sid -cne 'S-1-5-21-3058023354-1746979206-3201508519-1000' -or -not $Elevated) { throw 'PF_TRUSTED_PATHS' }
}
function Assert-AclPackageHash([string]$Actual, [string]$Expected) {
  if ($Expected -cnotmatch '^[0-9a-f]{64}$' -or $Actual.ToLowerInvariant() -cne $Expected) { throw 'PF_PACKAGE_HASH' }
}
function Assert-PublicAclPackage([string]$PackageRoot, [string]$ManifestHash, [string]$NodeExecutable, [string]$NodeHash) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User.Value
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  Assert-AclPackageIdentity $sid ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
  $root = (Assert-AclPackagePath $PackageRoot).TrimEnd('\')
  if ($root -like 'C:\Users\Admin\Desktop\NEW*' -or $root -eq 'C:') { throw 'PF_TRUSTED_PATHS' }
  $node = Assert-AclPackagePath $NodeExecutable
  # Runtime must be explicitly reviewed at the system installation, never PATH,
  # repository, user profile, UNC, shim, or staged source executable.
  if ($node -ine 'C:\Program Files\nodejs\node.exe') { throw 'PF_RUNTIME_TRUST' }
  Assert-AclPackageTreePath $root $root $sid
  Assert-AclPackageTreePath $node 'C:\Program Files\nodejs' $sid $false
  Assert-AclPackageHash (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash $NodeHash
  foreach ($name in @('NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_PG_FORCE_NATIVE','PGSERVICE','PGSERVICEFILE','PGPASSFILE')) {
    if ([Environment]::GetEnvironmentVariable($name)) { throw 'PF_RUNTIME_TRUST' }
  }
  $manifestPath = Join-Path $root 'scripts/public-acl-package.manifest.json'
  Assert-AclPackageTreePath $manifestPath $root $sid
  Assert-AclPackageHash (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash $ManifestHash
  $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
  if ($manifest.version -ne 1 -or $manifest.executionAuthorized -ne $false -or @($manifest.files).Count -lt 20) { throw 'PF_PACKAGE_HASH' }
  $expected = @('scripts/public-acl-package.manifest.json')
  foreach ($file in $manifest.files) {
    if ($file.path -cnotmatch '^(scripts|docs|supabase/migrations|node_modules)/[A-Za-z0-9_./-]+$' -or $file.path -match '(^|/)\.\.?(/|$)' -or $expected -icontains $file.path) { throw 'PF_PACKAGE_HASH' }
    $expected += $file.path
    $target = Join-Path $root $file.path
    Assert-AclPackageTreePath $target $root $sid
    Assert-AclPackageHash (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash $file.sha256
  }
  # Reject extra files and links, including alternative dependency resolution.
  foreach ($item in Get-ChildItem -LiteralPath $root -Recurse -Force) {
    Assert-AclPackageTreePath $item.FullName $root $sid
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'PF_TRUSTED_PATHS' }
    if (-not $item.PSIsContainer) {
      $relative = $item.FullName.Substring($root.Length + 1).Replace('\','/')
      if ($expected -inotcontains $relative) { throw 'PF_PACKAGE_HASH' }
    }
  }
}
