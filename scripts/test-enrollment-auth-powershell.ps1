# Offline regression harness: node and prompts are replaced before runner invocation.
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'qualify-enrollment-auth.ps1'
$temporaryNames = @('SMART_STORAGE_QUALIFICATION_EMAIL', 'SMART_STORAGE_QUALIFICATION_PASSWORD', 'SMART_STORAGE_QUALIFICATION_USER_ID', 'SMART_STORAGE_DEV_CLOUD_DATABASE_URL', 'SMART_STORAGE_PUBLISHER_CA_FILE', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL')
function Assert-Offline($condition) {
  if (-not $condition) { throw 'Offline PowerShell regression failed.' }
}
function Read-Host {
  param($Prompt, [switch]$AsSecureString)
  $global:ssEnrollmentTest_prompts++
  if ($global:ssEnrollmentTest_scenario -eq 'prompt-failure' -and $Prompt -eq 'Verified current account password') { throw 'synthetic-private-diagnostic' }
  if ($Prompt -like 'Separate hosted authorization*') {
    if ($global:ssEnrollmentTest_scenario -eq 'cancel') { return 'CANCEL' }
    return 'AUTHORIZED READ ONLY ENROLLMENT'
  }
  if ($Prompt -eq 'Existing restricted publisher password') {
    Assert-Offline $AsSecureString
    return ConvertTo-SecureString $global:ssEnrollmentTest_password -AsPlainText -Force
  }
  if ($Prompt -in @('Existing enrolled account email', 'Verified current account password')) {
    Assert-Offline $AsSecureString
    return ConvertTo-SecureString 'synthetic-user-value' -AsPlainText -Force
  }
  return 'synthetic-configuration'
}
function node {
  param($Path, $Mode)
  Assert-Offline ($Path -eq 'scripts/qualify-enrollment-auth.mjs')
  $global:LASTEXITCODE = 0
  if ($Mode -eq '--check') {
    $global:ssEnrollmentTest_checks++
    if ($global:ssEnrollmentTest_scenario -eq 'check-failure') { $global:LASTEXITCODE = 1 }
    return
  }
  Assert-Offline ($Mode -eq '--execute')
  $global:ssEnrollmentTest_executions++
  Assert-Offline ($global:ssEnrollmentTest_checks -eq 1)
  $prefix = 'postgresql://ss_dev_cloud_publisher_login.fneuqneqaopkmpeevlqz:'
  $suffix = '@aws-0-eu-west-1.pooler.supabase.com:5432/postgres'
  $url = $env:SMART_STORAGE_DEV_CLOUD_DATABASE_URL
  Assert-Offline ($url -ceq ($prefix + $global:ssEnrollmentTest_encoded + $suffix))
  $encodedPassword = $url.Substring($prefix.Length, $url.Length - $prefix.Length - $suffix.Length)
  Assert-Offline ([Uri]::UnescapeDataString($encodedPassword) -ceq $global:ssEnrollmentTest_password)
  Assert-Offline ($env:SMART_STORAGE_TRANSFERS_ENABLED -ceq 'false')
  Assert-Offline ($env:SMART_STORAGE_DEV_CLOUD_ENABLED -ceq 'false')
  Assert-Offline ($env:NEXT_PUBLIC_SUPABASE_URL -ceq 'https://fneuqneqaopkmpeevlqz.supabase.co')
  if ($global:ssEnrollmentTest_scenario -eq 'execute-failure') { $global:LASTEXITCODE = 1 }
  if ($global:ssEnrollmentTest_scenario -eq 'execute-throw') { throw 'synthetic-private-diagnostic' }
}

$cases = @(
  @{ Scenario = 'success'; Password = 'plain'; Encoded = 'plain' },
  @{ Scenario = 'success'; Password = 'p@:/?#[]%+ &='; Encoded = 'p%40%3A%2F%3F%23%5B%5D%25%2B%20%26%3D' },
  @{ Scenario = 'success'; Password = ('x' + [char]0x00e9 + [char]0x4e2d); Encoded = 'x%C3%A9%E4%B8%AD' },
  @{ Scenario = 'check-failure' },
  @{ Scenario = 'cancel' },
  @{ Scenario = 'prompt-failure' },
  @{ Scenario = 'execute-failure'; Password = 'plain'; Encoded = 'plain' },
  @{ Scenario = 'execute-throw'; Password = 'plain'; Encoded = 'plain' }
)
foreach ($case in $cases) {
  $global:ssEnrollmentTest_scenario = $case.Scenario
  $global:ssEnrollmentTest_password = $case.Password
  $global:ssEnrollmentTest_encoded = $case.Encoded
  $global:ssEnrollmentTest_checks = 0
  $global:ssEnrollmentTest_executions = 0
  $global:ssEnrollmentTest_prompts = 0
  foreach ($name in $temporaryNames) { [Environment]::SetEnvironmentVariable($name, 'synthetic-stale-value', 'Process') }
  $before = (Get-Location).Path
  $failureMessage = $null
  $output = @()
  try { $output = @(& $runner -Execute) } catch { $failureMessage = $_.Exception.Message }
  Assert-Offline ($output.Count -eq 0)
  Assert-Offline ((Get-Location).Path -eq $before)
  foreach ($name in $temporaryNames) { Assert-Offline ($null -eq [Environment]::GetEnvironmentVariable($name, 'Process')) }
  Assert-Offline ($global:ssEnrollmentTest_checks -eq 1)
  if ($case.Scenario -eq 'success') { Assert-Offline ($null -eq $failureMessage) }
  else { Assert-Offline ($failureMessage -ceq 'Enrollment qualification stopped. Do not retry without review.') }
  if ($case.Scenario -in @('check-failure', 'cancel', 'prompt-failure')) { Assert-Offline ($global:ssEnrollmentTest_executions -eq 0) }
  else { Assert-Offline ($global:ssEnrollmentTest_executions -eq 1) }
}
$global:ssEnrollmentTest_scenario = 'success'
$global:ssEnrollmentTest_checks = 0
$global:ssEnrollmentTest_executions = 0
$global:ssEnrollmentTest_prompts = 0
& $runner -Check
Assert-Offline ($global:ssEnrollmentTest_checks -eq 1 -and $global:ssEnrollmentTest_executions -eq 0 -and $global:ssEnrollmentTest_prompts -eq 0)
Write-Output 'PASS: 9 offline PowerShell cases; encoding, pinned endpoint, hidden credentials, cleanup, masked failures and check-only boundary.'
