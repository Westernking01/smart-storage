$ErrorActionPreference = 'Stop'
$base = 'C:\Users\Admin\Desktop\NEW\smart-storage\.cache\browser-roundtrip-20261020'
$pgBin = 'C:\Program Files\PostgreSQL\17\bin'
if (Test-Path -LiteralPath $base) { throw 'Existing target; inspect before any continuation.' }
$ancestor = Split-Path $base
while ($ancestor) {
  if (Test-Path -LiteralPath $ancestor) {
    if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse ancestor denied' }
  }
  $ancestor = Split-Path $ancestor
}
if (Get-NetTCPConnection -LocalPort 55461 -State Listen -ErrorAction SilentlyContinue) { throw 'Port conflict' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
New-Item -ItemType Directory -Path $base | Out-Null
Set-Acl -LiteralPath $base -AclObject $acl
New-Item -ItemType Directory -Path "$base\volume" | Out-Null
$volumeId = [guid]::NewGuid().ToString()
[IO.File]::WriteAllText("$base\volume\.volume-id", $volumeId, (New-Object Text.UTF8Encoding($false)))
$markerAcl = New-Object Security.AccessControl.FileSecurity
$markerAcl.SetOwner($sid)
$markerAcl.SetAccessRuleProtection($true,$false)
$markerAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow')))
Set-Acl -LiteralPath "$base\volume\.volume-id" -AclObject $markerAcl
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$randomBytes = New-Object byte[] 36
$rng.GetBytes($randomBytes)
$adminPassword = [Convert]::ToBase64String($randomBytes)
$rng.GetBytes($randomBytes)
$runtimePassword = [Convert]::ToBase64String($randomBytes)
$rng.Dispose()
ConvertTo-SecureString $adminPassword -AsPlainText -Force | ConvertFrom-SecureString | Set-Content "$base\admin.dpapi"
ConvertTo-SecureString $runtimePassword -AsPlainText -Force | ConvertFrom-SecureString | Set-Content "$base\runtime.dpapi"
[IO.File]::WriteAllText("$base\init-password", $adminPassword)
& "$pgBin\initdb.exe" -D "$base\postgres" -U postgres --auth=scram-sha-256 "--pwfile=$base\init-password" --encoding=UTF8 --no-locale
if ($LASTEXITCODE -ne 0) { throw 'initdb failed; no replay' }
Remove-Item -LiteralPath "$base\init-password"
@'
host smart_storage_gateway_test ss_volume_runtime 127.0.0.1/32 scram-sha-256
host all ss_volume_runtime 127.0.0.1/32 reject
host all postgres 127.0.0.1/32 scram-sha-256
host all all 0.0.0.0/0 reject
host all all ::0/0 reject
'@ | Set-Content "$base\postgres\pg_hba.conf"
& "$pgBin\pg_ctl.exe" -D "$base\postgres" -l "$base\postgres.log" -o '-h 127.0.0.1 -p 55461' -w start
if ($LASTEXITCODE -ne 0) { throw 'startup failed; no replay' }
$env:DISPOSABLE_ADMIN_PASSWORD = $adminPassword
$env:DISPOSABLE_RUNTIME_PASSWORD = $runtimePassword
try {
  & node "$PSScriptRoot\prepare-disposable-browser-database.mjs"
  if ($LASTEXITCODE -ne 0) { throw 'Database preparation stopped; inspect report; no replay' }
} finally {
  Remove-Item Env:DISPOSABLE_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:DISPOSABLE_RUNTIME_PASSWORD -ErrorAction SilentlyContinue
}
