# Offline only. Execute a synthetic source-derived fixture, never the real wrapper/host.
$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'inspect-public-acl-ownership-private.ps1') -Raw
# Trust integration is covered separately with offline descriptor fixtures.
$source = [regex]::Replace($source, '(?s)  # BEGIN PACKAGE TRUST:.*?  # END PACKAGE TRUST\r?\n', '')
$codes = @('PF_PATH','PF_ACL','PF_LISTENER','PF_PROCESS','PF_CONFIRMATION','PF_CREDENTIAL','PF_RUNTIME','PF_HANDOFF','PF_WAIT','PF_RESULT','PF_CLEANUP')
$actualCodes = @([regex]::Matches($source, "\`$stage = '(PF_[A-Z]+)'") | ForEach-Object { $_.Groups[1].Value })
if (($actualCodes -join ',') -cne ($codes -join ',')) { throw 'Unexpected stage order' }
$fixture = $source -replace "(?m)^\`$base = .*", "`$base = 'C:\synthetic-preflight'"
$fixture = $fixture.Replace('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value', "(Get-SyntheticIdentity)").Replace('[Security.Principal.WindowsIdentity]::GetCurrent().Name', "'SYNTHETIC_USER'")
# Entire credential/runtime/handoff/wait bodies are replaced before execution.
# This includes DPAPI, process creation, stdin and native pointer operations.
foreach ($code in @('PF_CREDENTIAL','PF_RUNTIME','PF_HANDOFF','PF_WAIT')) {
  $pattern = "(?s)(  \`$stage = '$code'\r?\n).*?(?=  \`$stage = ')"
  $fixture = [regex]::Replace($fixture, $pattern, ('$1' + "  Test-SyntheticGate '$code'`n"))
}
$fixture = $fixture.Replace('  $exitCode = $child.ExitCode', '  $exitCode = $script:syntheticExit')
$fixture = $fixture.Replace('  $stdout = $stdoutTask.GetAwaiter().GetResult()', "  `$stdout = Read-SyntheticOutput 'stdout'")
$fixture = $fixture.Replace('  $stderr = $stderrTask.GetAwaiter().GetResult()', "  `$stderr = Read-SyntheticOutput 'stderr'")
foreach ($entry in @(
  @('  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }', 'pointer'),
  @('    if ($secure) { $secure.Dispose() }', 'secure'),
  @('    if ($child) { $child.Dispose() }', 'child')
)) {
  $fixture = $fixture.Replace($entry[0], ("    Invoke-SyntheticCleanup '" + $entry[1] + "'"))
}
$fixture = $fixture -replace '(?m)^exit \$exitCode\s*$', 'if ($exitCode -ne $script:expectedExit) { throw "Unexpected exit code" }'
if ($fixture -match 'ConvertTo-SecureString|Get-Content.*admin\.dpapi|Process\]::Start|SecureStringToBSTR|ReadToEndAsync|WaitForExit|ZeroFreeBSTR|[.]Dispose[(]') { throw 'Unsafe fixture substitution' }
function Get-SyntheticIdentity {
  if ($script:variant -eq 'identity') { throw 'SYNTHETIC_SECRET identity' }
  'SYNTHETIC_SID'
}
function Test-SyntheticGate([string]$code) {
  $script:visited += $code
  if ($script:failure -eq $code) { throw 'SYNTHETIC_SECRET path=C:\private token=private process=private' }
}
function Read-SyntheticOutput([string]$stream) {
  if ($script:variant -eq ($stream + '-retrieval')) { throw 'SYNTHETIC_SECRET output retrieval path=C:\private' }
  if ($stream -eq 'stdout') { $script:syntheticStdout } else { $script:syntheticStderr }
}
function Invoke-SyntheticCleanup([string]$resource) {
  $script:cleaned += $resource
  if ($script:cleanupFailure -eq $resource -or $script:cleanupFailure -eq 'all') { throw 'SYNTHETIC_SECRET cleanup process=private' }
}
function Get-Item {
  param($LiteralPath, [switch]$Force)
  Test-SyntheticGate 'PF_PATH'
  @{ Attributes = $(if ($script:variant -eq 'reparse') { [IO.FileAttributes]::ReparsePoint } else { 0 }) }
}
function Get-Acl {
  param($LiteralPath)
  Test-SyntheticGate 'PF_ACL'
  $principal = New-Object PSObject
  $principal | Add-Member ScriptMethod Translate { param($type) if ($script:variant -eq 'translation') { throw 'SYNTHETIC_SECRET' }; @{Value=$(if ($script:variant -in @('ace','inherited-write','explicit-write','foreign-read','inherit-only')) {'OTHER'} else {'SYNTHETIC_SID'})} }
  @{ Owner=$(if ($script:variant -eq 'owner' -or ($script:variant -eq 'file-owner' -and $LiteralPath -like '*admin.dpapi')) {'OTHER'} elseif ($script:variant -eq 'sid-owner') {'SYNTHETIC_SID'} else {'SYNTHETIC_USER'}); Access=@(@{AccessControlType=$(if ($script:variant -eq 'foreign-deny') {'Deny'} else {'Allow'}); IdentityReference=$principal; IsInherited=($script:variant -in @('inherited-write','inherited-current')); FileSystemRights=$(if ($script:variant -eq 'foreign-read') {'Read'} else {'FullControl'}); PropagationFlags=$(if ($script:variant -eq 'inherit-only') {'InheritOnly'} else {'None'})}) }
}
function Get-NetTCPConnection {
  param($LocalPort,$State,$ErrorAction)
  Test-SyntheticGate 'PF_LISTENER'
  if ($LocalPort -ne 55461 -or $State -ne 'Listen') { throw 'Changed listener gate' }
  if ($script:variant -eq 'zero') { return }
  $row = @{LocalAddress=$(if ($script:variant -eq 'address') {'0.0.0.0'} else {'127.0.0.1'}); OwningProcess=123}
  $row
  if ($script:variant -eq 'multiple') { $row }
}
function Get-CimInstance {
  param($ClassName,$Filter,$ErrorAction)
  Test-SyntheticGate 'PF_PROCESS'
  if ($ClassName -ne 'Win32_Process' -or $Filter -ne 'ProcessId=123') { throw 'Changed process query' }
  @{ExecutablePath=$(if ($script:variant -eq 'executable') {'OTHER'} else {'C:\Program Files\PostgreSQL\17\bin\postgres.exe'}); ProcessId=123; CommandLine=$(if ($script:variant -eq 'directory') {'OTHER'} else {'"C:\Program Files\PostgreSQL\17\bin\postgres.exe" -D "C:/synthetic-preflight/postgres" -h 127.0.0.1 -p 55461'})}
}
function Read-Host {
  param($Prompt)
  Test-SyntheticGate 'PF_CONFIRMATION'
  if ($script:variant -eq 'confirmation') { 'inspect public acl once' } else { 'INSPECT PUBLIC ACL ONCE' }
}
$pass = 'PASS: Private ACL evidence captured. Review compatibility status; no migration authorization.'
$cases = @()
foreach ($code in $codes[0..8]) { $cases += @{Name="exception-$code"; Failure=$code; Stage=$(if ($code -eq 'PF_ACL') {'PF_ACL_READ'} elseif ($code -eq 'PF_PROCESS') {'PF_PROCESS_METADATA_UNAVAILABLE'} else {$code})} }
$cases += @{Name='child-failure'; Stage='PF_RESULT'; ChildExit=7}
foreach ($entry in @(@('reparse','PF_PATH'),@('identity','PF_ACL_IDENTITY'),@('file-owner','PF_ACL_OWNER'),@('owner','PF_ACL_OWNER'),@('ace','PF_ACL_EXPLICIT'),@('translation','PF_ACL_EXPLICIT'),@('inherited-write','PF_ACL_INHERITANCE'),@('explicit-write','PF_ACL_EXPLICIT'),@('foreign-read','PF_ACL_EXPLICIT'),@('inherit-only','PF_ACL_EXPLICIT'),@('zero','PF_LISTENER'),@('multiple','PF_LISTENER'),@('address','PF_LISTENER'),@('executable','PF_PROCESS'),@('directory','PF_PROCESS'),@('confirmation','PF_CONFIRMATION'))) {
  $cases += @{Name=$entry[0]; Variant=$entry[0]; Stage=$entry[1]}
}
$cases += @{Name='malformed-output'; Stage='PF_RESULT'; Stdout='SYNTHETIC_SECRET'}
$cases += @{Name='stderr'; Stage='PF_RESULT'; Stderr='SYNTHETIC_SECRET'}
foreach ($stream in @('stdout','stderr')) {
  $cases += @{Name=($stream + '-retrieval'); Variant=($stream + '-retrieval'); Stage='PF_RESULT'}
}
foreach ($resource in @('pointer','secure','child','all')) {
  $cases += @{Name=('success-then-cleanup-' + $resource); Cleanup=$resource; Stage='PF_CLEANUP'}
}
$cases += @{Name='early-failure-and-cleanup'; Failure='PF_ACL'; Cleanup='all'; Stage='PF_ACL_READ'}
$cases += @{Name='child-failure-and-cleanup'; ChildExit=7; Cleanup='all'; Stage='PF_RESULT'}
$cases += @{Name='retrieval-failure-and-cleanup'; Variant='stdout-retrieval'; Cleanup='all'; Stage='PF_RESULT'}
$cases += @{Name='success'}
$cases += @{Name='sid-owner'; Variant='sid-owner'}
$cases += @{Name='inherited-current'; Variant='inherited-current'}
$cases += @{Name='foreign-deny'; Variant='foreign-deny'}

foreach ($case in $cases) {
  $script:visited = @()
  $script:cleaned = @()
  $script:cleanupFailure = $case.Cleanup
  $script:failure = $case.Failure
  $script:variant = $case.Variant
  $script:syntheticExit = if ($case.ContainsKey('ChildExit')) { $case.ChildExit } else { 0 }
  $script:syntheticStdout = if ($case.ContainsKey('Stdout')) { $case.Stdout } else { $pass }
  $script:syntheticStderr = $case.Stderr
  $script:expectedExit = if ($case.Cleanup) { 1 } elseif ($case.Stage) { if ($script:syntheticExit) { $script:syntheticExit } else { 1 } } else { 0 }
  $output = (& ([scriptblock]::Create($fixture)) *>&1) -join "`n"
  $expected = if ($case.Stage) { 'BLOCKED: ' + $case.Stage } else { $pass }
  if ($output -cne $expected) { throw "Unexpected sanitized output: $($case.Name)" }
  if (($script:cleaned -join ',') -cne 'pointer,secure,child') { throw "Cleanup progression failed: $($case.Name)" }
  $ordered = @($script:visited | Select-Object -Unique)
  $last = if ($case.Stage) { [array]::IndexOf($codes, (($case.Stage -replace '^PF_ACL_.*$', 'PF_ACL') -replace '^PF_PROCESS_.*$', 'PF_PROCESS')) } else { $codes.Count - 1 }
  # PF_RESULT is the real final predicate, so no synthetic gate records it.
  $expectedVisited = if ($case.Variant -eq 'identity') { @('PF_PATH') } else { @($codes[0..([Math]::Min($last,8))]) }
  if (($ordered -join ',') -cne ($expectedVisited -join ',')) { throw "Progression failed: $($case.Name)" }
  Write-Output "PASS offline: $($case.Name)"
}
Write-Output "PASS: $($cases.Count) synthetic cases; no real wrapper or host invoked."

# Parse both files offline; never invoke the wrapper or host.
foreach ($file in @('inspect-public-acl-ownership-private.ps1','test-public-acl-preflight-stages.ps1')) {
  $tokens = $null; $parseErrors = $null
  $null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file), [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count) { throw 'PowerShell AST failure' }
}
# Static invariants: one launch/connect, exclusive reservation before connection,
# no retry loop. These read source only and never inspect the real fence.
$hostSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'inspect-public-acl-ownership-private.mjs') -Raw
if (([regex]::Matches($source, '\[Diagnostics.Process\]::Start\(')).Count -ne 1 -or
    ([regex]::Matches($hostSource, 'await client[.]connect\(')).Count -ne 1 -or
    $hostSource.IndexOf('reserved = true') -gt $hostSource.IndexOf('await client.connect()') -or
    $hostSource -notmatch 'flag: "wx"' -or $hostSource -match '\b(?:while|setInterval)\s*\(') { throw 'Fence/no-retry invariant failure' }
Write-Output 'PASS: PowerShell AST and static fence/no-retry invariants.'
