# Offline source transformation only. No filesystem, credentials, or execution.
# Caller must supply the consumed/reserved identity inventory before later use.
# This helper does not authorize execution; host CreateNew/wx remains mandatory.
function New-PublicAclExecutionSource {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$ExpectedIdentity,
        [Parameter(Mandatory)][string]$NewIdentity,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$ConsumedIdentities
    )
    $historicalFormat = '\A[0-9]{8}-(?:final-[0-9a-f]{8}|once-[0-9a-f]{32})\z'
    $freshFormat = '\A[0-9]{8}-once-[0-9a-f]{32}\z'
    if ($ExpectedIdentity -cnotmatch $historicalFormat -or $NewIdentity -cnotmatch $freshFormat) {
        throw 'IDENTITY_FORMAT_BLOCKED'
    }
    if ($NewIdentity -ceq $ExpectedIdentity -or $ConsumedIdentities -contains $NewIdentity) {
        throw 'IDENTITY_REUSE_BLOCKED'
    }
    $prefixes = @('docs/public-acl-ownership-evidence.', '.cache/browser-roundtrip-20261020/public-acl-ownership-once.')
    # Count literal strings; String.Split(string) is a character-set overload in
    # Windows PowerShell and cannot establish exact identity occurrence counts.
    if ([regex]::Matches($Source, [regex]::Escape($ExpectedIdentity)).Count -ne 2) {
        throw 'IDENTITY_REFERENCE_BLOCKED'
    }
    foreach ($prefix in $prefixes) {
        $binding = '"' + $prefix + $ExpectedIdentity + '.json"'
        if ([regex]::Matches($Source, [regex]::Escape($binding)).Count -ne 1) {
            throw 'IDENTITY_REFERENCE_BLOCKED'
        }
    }
    if ($Source.Contains($NewIdentity)) { throw 'IDENTITY_REUSE_BLOCKED' }
    $Source.Replace($ExpectedIdentity, $NewIdentity)
}
