# Offline only: copied wrapper, synthetic DPAPI substitute, fake Node checker.
$ErrorActionPreference = 'Stop'
$directory = Join-Path ([IO.Path]::GetTempPath()) ('private-inspection-test-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $directory
try {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'private-inspection-output.ps1') -Destination $directory
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'inspect-disposable-postgres-private.ps1') -Raw
  $begin = $source.IndexOf('  $ancestor =')
  $end = $source.IndexOf('  if ($secure.Length')
  if ($begin -lt 0 -or $end -le $begin) { throw 'Fixture substitution failed' }
  $source = $source.Substring(0, $begin) + "  `$secure = ConvertTo-SecureString 'SYNTHETIC_SECRET' -AsPlainText -Force`r`n" + $source.Substring($end)
  $wrapper = Join-Path $directory 'wrapper.ps1'
  Set-Content -LiteralPath $wrapper -Value $source -Encoding UTF8
  $checker = Join-Path $directory 'inspect-disposable-postgres-private.mjs'
  $cases = @(
    @{ Name='success'; Code=0; Pass=$true; Body='console.log(JSON.stringify({status:"READ_ONLY_PREFLIGHT_PASS",qualificationReady:false,migrationsApplied:false,adr041:"OPEN",target:{password:"SYNTHETIC_SECRET"}}));' },
    @{ Name='failure'; Code=7; Pass=$false; Body='console.log("postgres://user:SYNTHETIC_SECRET@localhost/db"); console.error("token=SYNTHETIC_SECRET"); process.exitCode=7;' },
    @{ Name='malformed'; Code=1; Pass=$false; Body='console.log("SYNTHETIC_SECRET");' },
    @{ Name='stderr-redaction'; Code=1; Pass=$false; Body='console.log(JSON.stringify({status:"READ_ONLY_PREFLIGHT_PASS",qualificationReady:false,migrationsApplied:false,adr041:"OPEN"})); console.error("SYNTHETIC_SECRET");' }
  )
  foreach ($case in $cases) {
    Set-Content -LiteralPath $checker -Value ('let input=""; for await (const c of process.stdin) input+=c; if(input!=="SYNTHETIC_SECRET") process.exit(9); ' + $case.Body) -Encoding UTF8
    $output = (& powershell.exe -NoProfile -File $wrapper 2>&1) -join "`n"
    $actualCode = $LASTEXITCODE
    if ($actualCode -ne $case.Code) { throw "Unexpected exit status: $($case.Name)" }
    if ($output -match 'SYNTHETIC_SECRET|postgres://|token=|password') { throw "Redaction failed: $($case.Name)" }
    if ($case.Pass -and $output -notmatch '^PASS:') { throw 'Missing PASS' }
    if (-not $case.Pass -and $output -notmatch '^FAIL:') { throw 'Missing FAIL' }
    Write-Output "PASS offline: $($case.Name)"
  }
} finally {
  # Deliberately keep the small synthetic fixtures; no recursive deletion.
}
