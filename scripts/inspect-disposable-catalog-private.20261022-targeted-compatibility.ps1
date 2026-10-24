# Operator-run read-only preflight. Never dot-source; no environment export.
$ErrorActionPreference = 'Stop'
# Dedicated catalog host: fixed output allowlist below.
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
  $checker = Join-Path $PSScriptRoot 'inspect-disposable-catalog-private.20261022-targeted-compatibility.mjs'
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
  if (-not $child.WaitForExit(60000)) { $child.Kill(); throw 'Preflight timed out' }
  $exitCode = $child.ExitCode
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  if ($exitCode -eq 0 -and $stdout.Trim() -ceq 'PASS: Private read-only catalog inspection completed. Compatibility requires report review.' -and [string]::IsNullOrWhiteSpace($stderr)) {
    Write-Output 'PASS: Private read-only catalog inspection completed. Compatibility requires report review.'
  } else {
    if ($exitCode -eq 0) { $exitCode = 1 }
    Write-Output 'FAIL: Private read-only catalog inspection blocked. No retry or credential reset.'
  }
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

