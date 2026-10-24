param([switch]$Check, [switch]$Execute)
$ErrorActionPreference = 'Stop'
if ($Check -eq $Execute) { Write-Output 'FAIL: POOL_LIFECYCLE_FAILED'; exit 1 }
$failureReported = $false
Push-Location (Join-Path $PSScriptRoot '..')
try {
  & node scripts/qualify-pool-isolation.mjs --check
  if ($LASTEXITCODE -ne 0) { $failureReported = $true; throw 'Offline check failed.' }
  if ($Check) { return }
  if ((Read-Host 'Separate hosted authorization required. Type AUTHORIZED READ ONLY POOL ISOLATION') -cne 'AUTHORIZED READ ONLY POOL ISOLATION') {
    throw 'Execution cancelled.'
  }
  # Run in a fresh normal PowerShell process without transcription/debug tracing.
  # Values are entered through protected prompts, never command-line arguments.
  $env:SMART_STORAGE_TRANSFERS_ENABLED = 'false'
  $env:SMART_STORAGE_DEV_CLOUD_ENABLED = 'false'
  $env:NEXT_PUBLIC_SUPABASE_URL = 'https://fneuqneqaopkmpeevlqz.supabase.co'
  $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = Read-Host 'Existing development publishable key (sb_publishable_)'
  $env:SMART_STORAGE_PUBLISHER_CA_FILE = Read-Host 'Absolute path to reviewed publisher CA certificate'
  $env:SMART_STORAGE_POOL_A_ID = Read-Host 'Existing enrolled test account UUID (do not enroll/change an account)'
  foreach ($entry in @(
    @('SMART_STORAGE_POOL_A_EMAIL', 'Existing enrolled account email'),
    @('SMART_STORAGE_POOL_A_PASSWORD', 'Verified current account password'),
    @('SMART_STORAGE_DEV_CLOUD_DATABASE_URL', 'Existing restricted publisher password')
  )) {
    $protectedValue = Read-Host $entry[1] -AsSecureString
    $pointer = [IntPtr]::Zero
    try {
      $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($protectedValue)
      $plainValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
      if ([string]::IsNullOrEmpty($plainValue) -or $plainValue.Length -gt 1024) { throw 'Protected input length invalid.' }
      if ($entry[0] -eq 'SMART_STORAGE_DEV_CLOUD_DATABASE_URL') {
        if ([string]::IsNullOrEmpty($plainValue)) { throw 'Publisher password required.' }
        $plainValue = 'postgresql://ss_dev_cloud_publisher_login.fneuqneqaopkmpeevlqz:' + [Uri]::EscapeDataString($plainValue) + '@aws-0-eu-west-1.pooler.supabase.com:5432/postgres'
      }
      [Environment]::SetEnvironmentVariable($entry[0], $plainValue, 'Process')
    } finally {
      $plainValue = $null
      if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
      $protectedValue.Dispose()
    }
  }
  if ($env:SMART_STORAGE_DEV_CLOUD_PUBLISHER) { throw 'Runtime selector must be unset.' }
  if ((Read-Host 'Use a separately approved existing second enrolled account? Type YES or NO') -ceq 'YES') {
    $env:SMART_STORAGE_POOL_B_ID = Read-Host 'Second enrolled ordinary account UUID'
    foreach ($entry in @(@('SMART_STORAGE_POOL_B_EMAIL','Second account email'), @('SMART_STORAGE_POOL_B_PASSWORD','Verified current second account password'))) {
      $secret = Read-Host $entry[1] -AsSecureString
      $ptr = [IntPtr]::Zero
      try {
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        [Environment]::SetEnvironmentVariable($entry[0], [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr), 'Process')
      } finally {
        if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
        $secret.Dispose()
      }
    }
  } else {
    foreach ($name in @('SMART_STORAGE_POOL_B_ID','SMART_STORAGE_POOL_B_EMAIL','SMART_STORAGE_POOL_B_PASSWORD')) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
  }
  & node scripts/qualify-pool-isolation.mjs --execute
  if ($LASTEXITCODE -ne 0) { $failureReported = $true; throw 'Qualification failed. Stop; do not retry.' }
} catch {
  # Prompt, conversion and native-command exceptions must not expose input.
  if (-not $failureReported) { Write-Output 'FAIL: POOL_LIFECYCLE_FAILED' }
  exit 1
} finally {
  if ($Execute) {
    foreach ($name in @('SMART_STORAGE_POOL_B_ID','SMART_STORAGE_POOL_B_EMAIL','SMART_STORAGE_POOL_B_PASSWORD','SMART_STORAGE_POOL_A_EMAIL', 'SMART_STORAGE_POOL_A_PASSWORD', 'SMART_STORAGE_POOL_A_ID', 'SMART_STORAGE_DEV_CLOUD_DATABASE_URL', 'SMART_STORAGE_PUBLISHER_CA_FILE', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL')) {
      [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
  }
  Pop-Location
}
