# Operator-run read-only preflight. Never dot-source; no environment export.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'private-inspection-output.ps1')
$base = 'C:\Users\Admin\Desktop\NEW\smart-storage\.cache\browser-roundtrip-20261020'
$secure = $null
$pointer = [IntPtr]::Zero
$child = $null
$exitCode = 1
try {
  $ancestor = Join-Path $base 'admin.dpapi'
  while ($ancestor) {
    if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe path' }
    $ancestor = Split-Path $ancestor
  }
  $secure = (Get-Content -LiteralPath (Join-Path $base 'admin.dpapi') -Raw).Trim() | ConvertTo-SecureString
  if ($secure.Length -eq 0) { throw 'Missing credential' }
  $node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
  $checker = Join-Path $PSScriptRoot 'inspect-disposable-postgres-private.mjs'
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $node
  $start.Arguments = '"' + $checker + '"'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $child = [Diagnostics.Process]::Start($start)
  # Drain both pipes concurrently before waiting, including on failure.
  $stdoutTask = $child.StandardOutput.ReadToEndAsync()
  $stderrTask = $child.StandardError.ReadToEndAsync()
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $child.StandardInput.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))
  $child.StandardInput.Close()
  if (-not $child.WaitForExit(20000)) { $child.Kill(); throw 'Preflight timed out' }
  $exitCode = $child.ExitCode
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  $messages = @(Write-PrivateInspectionResult -ChildExitCode $exitCode -Stdout $stdout -Stderr $stderr)
  $messages | Write-Output
  if ($exitCode -eq 0 -and $messages[0].StartsWith('FAIL:')) { $exitCode = 1 }
} catch {
  $exitCode = 1
  Write-Output 'FAIL: Private disposable preflight unavailable or timed out. Do not reset credentials or replay setup.'
} finally {
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  if ($secure) { $secure.Dispose() }
  if ($child) { $child.Dispose() }
  $secure = $null
}
exit $exitCode
