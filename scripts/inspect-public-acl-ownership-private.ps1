# Operator-run read-only preflight. Never dot-source; no environment export.
param([string]$NodeExecutable, [string]$NodeHash, [string]$ManifestHash)
$ErrorActionPreference = 'Stop'
# Dedicated catalog host: fixed output allowlist below.
# Pure validation; only the reviewed, separated -D/-h/-p startup grammar is accepted.
function ConvertTo-ProcessIdentityPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z]:[\\/]' -or $Value -match '[\x00-\x1f"*?<>|]' -or $Value.Substring(2).Contains(':')) { throw 'Invalid path' }
  [IO.Path]::GetFullPath($Value.Replace('/', '\')).TrimEnd('\')
}
function Test-PublicAclProcessIdentity($Server, $ListenerPid, [string]$ExpectedDirectory) {
  if (@($Server).Count -ne 1 -or $null -eq $Server -or [string]::IsNullOrWhiteSpace($Server.ExecutablePath) -or [string]::IsNullOrWhiteSpace($Server.CommandLine) -or $null -eq $Server.ProcessId) { return 'PF_PROCESS_METADATA_UNAVAILABLE' }
  try {
    if ([string]$ListenerPid -notmatch '^[1-9][0-9]*$' -or [string]$Server.ProcessId -cne [string]$ListenerPid) { return 'PF_PROCESS' }
    $exe = ConvertTo-ProcessIdentityPath 'C:\Program Files\PostgreSQL\17\bin\postgres.exe'
    if ((ConvertTo-ProcessIdentityPath $Server.ExecutablePath) -ine $exe) { return 'PF_PROCESS' }
    $line = [string]$Server.CommandLine
    $arguments = @()
    while ($line.Length) {
      $m = [regex]::Match($line, '^\s*(?:"([^"\r\n]*)"|([^\s"]+))(?=\s|$)')
      if (-not $m.Success) { return 'PF_PROCESS' }
      $value = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }
      # Embedded quotes and Windows quote-escape ambiguity fail closed.
      if (-not $value.Length -or ($m.Groups[1].Success -and $value.EndsWith('\'))) { return 'PF_PROCESS' }
      $arguments += $value
      $line = $line.Substring($m.Length).TrimStart()
    }
    if ($arguments.Count -ne 7 -or (ConvertTo-ProcessIdentityPath $arguments[0]) -ine $exe) { return 'PF_PROCESS' }
    $options = @{}
    for ($i = 1; $i -lt $arguments.Count; $i += 2) {
      $key = $arguments[$i]
      if ($key -cnotin @('-D','-h','-p') -or $options.ContainsKey($key)) { return 'PF_PROCESS' }
      $options[$key] = $arguments[$i + 1]
    }
    if ($options.Count -ne 3 -or $options['-h'] -cne '127.0.0.1' -or $options['-p'] -cne '55461' -or (ConvertTo-ProcessIdentityPath $options['-D']) -ine (ConvertTo-ProcessIdentityPath $ExpectedDirectory)) { return 'PF_PROCESS' }
    return $null
  } catch { return 'PF_PROCESS' }
}
$base = 'C:\Users\Admin\Desktop\NEW\smart-storage\.cache\browser-roundtrip-20261020'
$secure = $null
$pointer = [IntPtr]::Zero
$child = $null
$exitCode = 1
$resultValidated = $false
$failureStage = $null
$stage = 'PF_PATH'
try {
  # BEGIN PACKAGE TRUST: checked before any protected-state or credential access.
  $stage = 'PF_TRUSTED_PATHS'
  . (Join-Path $PSScriptRoot 'public-acl-package-trust.ps1')
  Assert-PublicAclPackage (Split-Path $PSScriptRoot) $ManifestHash $NodeExecutable $NodeHash
  $stage = 'PF_PATH'
  # END PACKAGE TRUST
  $ancestor = Join-Path $base 'admin.dpapi'
  while ($ancestor) {
    if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe path' }
    $ancestor = Split-Path $ancestor
  }
  # Local-only validation, before credential recovery. Never repair ACLs here.
  $stage = 'PF_ACL'
  $stage = 'PF_ACL_IDENTITY'
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  foreach ($protected in @($base, (Join-Path $base 'admin.dpapi'))) {
    $stage = 'PF_ACL_READ'
    $acl = Get-Acl -LiteralPath $protected
    $stage = 'PF_ACL_OWNER'
    if ($acl.Owner -ne [Security.Principal.WindowsIdentity]::GetCurrent().Name -and $acl.Owner -ne $identity) { throw 'Owner mismatch' }
    # Credential isolation is stricter than effective-write validation: foreign
    # Allow ACEs remain forbidden even if read-only, inherit-only or denied elsewhere.
    # Inherited current-user ACEs are accepted; inheritance alone is not a failure.
    $stage = 'PF_ACL_ACCESS'
    foreach ($ace in $acl.Access) {
      $stage = 'PF_ACL_EXPLICIT'
      if ($ace.IsInherited) { $stage = 'PF_ACL_INHERITANCE' }
      if ($ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $identity) { throw 'Credential ACL mismatch' }
    }
  }
  $stage = 'PF_LISTENER'
  $listeners = @(Get-NetTCPConnection -LocalPort 55461 -State Listen -ErrorAction Stop)
  if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1') { throw 'Listener mismatch' }
  $stage = 'PF_PROCESS'
  try {
    $server = @(Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listeners[0].OwningProcess) -ErrorAction Stop)
  } catch {
    $stage = ('PF_PROCESS_METADATA_UNAVAILABLE')
    throw 'Process metadata unavailable'
  }
  $processFailure = Test-PublicAclProcessIdentity $server $listeners[0].OwningProcess (Join-Path $base 'postgres')
  if ($processFailure) { $stage = $processFailure; throw 'Process validation blocked' }
  $stage = 'PF_CONFIRMATION'
  if ((Read-Host 'After separate authorization, type INSPECT PUBLIC ACL ONCE') -cne 'INSPECT PUBLIC ACL ONCE') { throw 'Not confirmed' }
  $stage = 'PF_CREDENTIAL'
  $secure = (Get-Content -LiteralPath (Join-Path $base 'admin.dpapi') -Raw).Trim() | ConvertTo-SecureString
  if ($secure.Length -eq 0) { throw 'Missing credential' }
  $stage = 'PF_RUNTIME'
  $node = $NodeExecutable
  $checker = Join-Path $PSScriptRoot 'inspect-public-acl-ownership-private.mjs'
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $node
  $start.Arguments = '"' + $checker + '"'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.WorkingDirectory = Split-Path $PSScriptRoot
  $stage = 'PF_HANDOFF'
  $child = [Diagnostics.Process]::Start($start)
  # Drain both pipes concurrently before waiting, including on failure.
  $stdoutTask = $child.StandardOutput.ReadToEndAsync()
  $stderrTask = $child.StandardError.ReadToEndAsync()
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $child.StandardInput.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))
  $child.StandardInput.Close()
  $stage = 'PF_WAIT'
  if (-not $child.WaitForExit(60000)) { $child.Kill(); throw 'Preflight timed out' }
  $stage = 'PF_RESULT'
  $exitCode = $child.ExitCode
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  if ($exitCode -eq 0 -and $stdout.Trim() -ceq 'PASS: Private ACL evidence captured. Review compatibility status; no migration authorization.' -and [string]::IsNullOrWhiteSpace($stderr)) {
    $resultValidated = $true
  } else {
    if ($exitCode -eq 0) { $exitCode = 1 }
    $failureStage = $stage
  }
} catch {
  $exitCode = 1
  $failureStage = $stage
} finally {
  $stage = 'PF_CLEANUP'
  # Attempt every cleanup independently; retain the first failure boundary.
  try {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  } catch {
    $exitCode = 1
    if (-not $failureStage) { $failureStage = $stage }
  }
  try {
    if ($secure) { $secure.Dispose() }
  } catch {
    $exitCode = 1
    if (-not $failureStage) { $failureStage = $stage }
  }
  try {
    if ($child) { $child.Dispose() }
  } catch {
    $exitCode = 1
    if (-not $failureStage) { $failureStage = $stage }
  }
  $secure = $null
}
# Emit exactly one result, only after validation and mandatory cleanup.
if ($resultValidated -and $exitCode -eq 0 -and -not $failureStage) {
  Write-Output 'PASS: Private ACL evidence captured. Review compatibility status; no migration authorization.'
} else {
  if ($exitCode -eq 0) { $exitCode = 1 }
  if (-not $failureStage) { $failureStage = 'PF_RESULT' }
  Write-Output "BLOCKED: $failureStage"
}
exit $exitCode

