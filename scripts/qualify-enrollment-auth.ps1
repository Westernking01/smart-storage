param([switch]$Check, [switch]$Execute)
$ErrorActionPreference = 'Stop'
if ($Check -eq $Execute) { throw 'Select exactly one of -Check or -Execute.' }
Push-Location (Join-Path $PSScriptRoot '..')
try {
  & node scripts/qualify-enrollment-auth.mjs --check
  if ($LASTEXITCODE -ne 0) { throw 'Offline check failed.' }
  if ($Check) { return }
  if ((Read-Host 'Separate hosted authorization required. Type AUTHORIZED READ ONLY ENROLLMENT') -cne 'AUTHORIZED READ ONLY ENROLLMENT') {
    throw 'Execution cancelled.'
  }
  # Run in a fresh normal PowerShell process without transcription/debug tracing.
  # Values are entered through protected prompts, never command-line arguments.
  $env:SMART_STORAGE_TRANSFERS_ENABLED = 'false'
  $env:SMART_STORAGE_DEV_CLOUD_ENABLED = 'false'
  $env:NEXT_PUBLIC_SUPABASE_URL = 'https://fneuqneqaopkmpeevlqz.supabase.co'
  $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = Read-Host 'Existing development publishable key (sb_publishable_)'
  $env:SMART_STORAGE_PUBLISHER_CA_FILE = Read-Host 'Absolute path to reviewed publisher CA certificate'
  $env:SMART_STORAGE_QUALIFICATION_USER_ID = Read-Host 'Existing enrolled test account UUID (do not enroll/change an account)'
  foreach ($entry in @(
    @('SMART_STORAGE_QUALIFICATION_EMAIL', 'Existing enrolled account email'),
    @('SMART_STORAGE_QUALIFICATION_PASSWORD', 'Verified current account password'),
    @('SMART_STORAGE_DEV_CLOUD_DATABASE_URL', 'Existing restricted publisher password')
  )) {
    $protectedValue = Read-Host $entry[1] -AsSecureString
    $pointer = [IntPtr]::Zero
    try {
      $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($protectedValue)
      $plainValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
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
  & node scripts/qualify-enrollment-auth.mjs --execute
  if ($LASTEXITCODE -ne 0) { throw 'Qualification failed. Stop; do not retry.' }
} catch {
  # Prompt, conversion and native-command exceptions must not expose input.
  throw 'Enrollment qualification stopped. Do not retry without review.'
} finally {
  if ($Execute) {
    foreach ($name in @('SMART_STORAGE_QUALIFICATION_EMAIL', 'SMART_STORAGE_QUALIFICATION_PASSWORD', 'SMART_STORAGE_QUALIFICATION_USER_ID', 'SMART_STORAGE_DEV_CLOUD_DATABASE_URL', 'SMART_STORAGE_PUBLISHER_CA_FILE', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL')) {
      [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
  }
  Pop-Location
}
