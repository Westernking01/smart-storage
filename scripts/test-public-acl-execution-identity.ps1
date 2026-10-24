# Offline regression tests: transform text only; never invoke the host or touch fences.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'public-acl-execution-identity.ps1')
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'inspect-public-acl-ownership-private.mjs'))
$old = '20261022-once-dd28b358ee5a42b7a7323f8a802c4351'
# Fixed synthetic text only; never mint an execution authorization in a test.
$fresh = '20990101-once-00000000000000000000000000000000'
$script:passed = 0
function Expect-Blocked($text, $identity, $consumed, $code) {
    try {
        $null = New-PublicAclExecutionSource -Source $text -ExpectedIdentity $old -NewIdentity $identity -ConsumedIdentities $consumed
    } catch {
        if ($_.Exception.Message -cne $code) { throw }
        $script:passed++
        return
    }
    throw 'Expected rejection'
}
if ([regex]::Matches($source, [regex]::Escape($old)).Count -ne 2) { throw 'Fixture binding drift' }
$changed = New-PublicAclExecutionSource -Source $source -ExpectedIdentity $old -NewIdentity $fresh -ConsumedIdentities @($old)
if ($changed.Contains($old) -or [regex]::Matches($changed, [regex]::Escape($fresh)).Count -ne 2) { throw 'Fresh binding failed' }
if ($changed.Replace($fresh, $old) -cne $source) { throw 'Unrelated source changed' }
$script:passed++
Expect-Blocked $source $fresh @($fresh) 'IDENTITY_REUSE_BLOCKED'
Expect-Blocked ($source.Replace('once.' + $old, 'once.20261022-final-00000000')) $fresh @() 'IDENTITY_REFERENCE_BLOCKED'
Expect-Blocked ($source + $old) $fresh @() 'IDENTITY_REFERENCE_BLOCKED'
Expect-Blocked ($source.Replace('docs/public-acl-ownership-evidence.', 'docs/wrong.')) $fresh @() 'IDENTITY_REFERENCE_BLOCKED'
Expect-Blocked ($source + $fresh) $fresh @() 'IDENTITY_REUSE_BLOCKED'
foreach ($invalid in @('../escape', '20261022-once-short', '20261022-once-' + ('A' * 32), ($fresh + "`n"))) {
    Expect-Blocked $source $invalid @() 'IDENTITY_FORMAT_BLOCKED'
}
# A previously prepared valid once identity must also never be reused.
try {
    $null = New-PublicAclExecutionSource -Source $changed -ExpectedIdentity $fresh -NewIdentity $fresh -ConsumedIdentities @()
    throw 'Expected reuse rejection'
} catch {
    if ($_.Exception.Message -cne 'IDENTITY_REUSE_BLOCKED') { throw }
    $script:passed++
}
if ($source -cne [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'inspect-public-acl-ownership-private.mjs'))) { throw 'Host modified' }
Write-Output "$script:passed identity regression tests PASS; host unchanged; no fence access."
