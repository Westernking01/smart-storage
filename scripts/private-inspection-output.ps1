# Pure output policy: never forward child output or exception text.
function Write-PrivateInspectionResult {
  param([int]$ChildExitCode, [string]$Stdout, [string]$Stderr)
  if ($ChildExitCode -ne 0) {
    Write-Output 'FAIL: Private disposable preflight blocked. Do not reset credentials or replay setup.'
    return
  }
  try {
    $report = ConvertFrom-Json -InputObject $Stdout -ErrorAction Stop
    if ($report.status -cne 'READ_ONLY_PREFLIGHT_PASS' -or
        $report.qualificationReady -isnot [bool] -or $report.qualificationReady -ne $false -or
        $report.migrationsApplied -isnot [bool] -or $report.migrationsApplied -ne $false -or
        $report.adr041 -cne 'OPEN' -or -not [string]::IsNullOrWhiteSpace($Stderr)) {
      throw 'Invalid report'
    }
    Write-Output 'PASS: Private disposable read-only preflight.'
    Write-Output 'BLOCKERS: Qualification not ready; migrations not applied; ADR-041 OPEN. Production transfers remain disabled.'
  } catch {
    Write-Output 'FAIL: Missing or unexpected sanitized inspection report. Do not replay setup.'
  }
}
