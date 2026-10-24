# Dot-source in a dedicated private shell. Does not launch an application.
$ErrorActionPreference = 'Stop'
$disposableBase = 'C:\Users\Admin\Desktop\NEW\smart-storage\.cache\browser-roundtrip-20261020'
$disposableRoot = Join-Path $disposableBase 'volume'
if ((Get-Item -LiteralPath $disposableRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe volume' }
$disposableId = (Get-Content -LiteralPath "$disposableRoot\.volume-id" -Raw).Trim()
if ($disposableId -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') { throw 'Invalid marker' }
$disposableSecure = (Get-Content -LiteralPath "$disposableBase\runtime.dpapi" -Raw).Trim() | ConvertTo-SecureString
$disposablePassword = [Net.NetworkCredential]::new('', $disposableSecure).Password
$env:SMART_STORAGE_ENV = 'development'
$env:SMART_STORAGE_BACKEND_ENABLED = 'true'
$env:SMART_STORAGE_TRANSFERS_ENABLED = 'false'
$env:SMART_STORAGE_LOCAL_VOLUME_ENABLED = 'false'
$env:APP_ORIGIN = 'http://localhost:3000'
$env:SMART_STORAGE_LOCAL_VOLUME_ROOT = $disposableRoot
$env:SMART_STORAGE_LOCAL_VOLUME_ID = $disposableId
$env:SMART_STORAGE_LOCAL_DATABASE_URL = 'postgresql://ss_volume_runtime:' + [Uri]::EscapeDataString($disposablePassword) + '@127.0.0.1:55461/smart_storage_gateway_test'
$disposablePassword = $null
$disposableSecure = $null
