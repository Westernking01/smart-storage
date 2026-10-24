# Offline: extract only pure function ASTs; never execute the wrapper body.
$ErrorActionPreference = 'Stop'
$files = @('inspect-public-acl-ownership-private.ps1','test-public-acl-preflight-stages.ps1','test-public-acl-process-identity.ps1')
foreach ($file in $files) {
  $tokens=$null; $errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file),[ref]$tokens,[ref]$errors)
  if ($errors.Count) { throw 'Syntax failure' }
  if ($file -eq $files[0]) {
    $functions=$ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)
    if ($functions.Count -ne 2) { throw 'Unexpected validator functions' }
    foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }
  }
}
$exe='C:\Program Files\PostgreSQL\17\bin\postgres.exe'
$dir='C:\synthetic-preflight\postgres'
$prefix='"'+$exe+'" '
$valid='-D "C:/synthetic-preflight/postgres" -h 127.0.0.1 -p 55461'
$cases=@(
  @{Name='forward slashes'; Args=$valid},
  @{Name='backslashes'; Args=$valid.Replace('/','\')},
  @{Name='canonical case and dot segments'; Args=$valid.Replace('C:/synthetic-preflight/postgres','c:/SYNTHETIC-preflight/child/../postgres')},
  @{Name='option order'; Args='-p 55461 -h 127.0.0.1 -D "C:/synthetic-preflight/postgres"'},
  @{Name='wrong directory'; Args=$valid.Replace('/postgres','/other'); Fail='PF_PROCESS'},
  @{Name='directory suffix'; Args=$valid.Replace('/postgres','/postgres-other'); Fail='PF_PROCESS'},
  @{Name='missing D arbitrary occurrence'; Args='-h 127.0.0.1 -p 55461 C:/synthetic-preflight/postgres'; Fail='PF_PROCESS'},
  @{Name='missing D value'; Args='-D -h 127.0.0.1 -p 55461'; Fail='PF_PROCESS'},
  @{Name='unterminated quote'; Args=$valid+' "'; Fail='PF_PROCESS'},
  @{Name='embedded quote'; Args=$valid.Replace('/postgres','/post"gres'); Fail='PF_PROCESS'},
  @{Name='empty D'; Args='-D "" -h 127.0.0.1 -p 55461'; Fail='PF_PROCESS'},
  @{Name='duplicate D'; Args=$valid+' -D C:/other'; Fail='PF_PROCESS'},
  @{Name='duplicate host'; Args=$valid+' -h 0.0.0.0'; Fail='PF_PROCESS'},
  @{Name='config override'; Args=$valid+' -c data_directory=C:/other'; Fail='PF_PROCESS'},
  @{Name='wrong host'; Args=$valid.Replace('127.0.0.1','0.0.0.0'); Fail='PF_PROCESS'},
  @{Name='wrong port'; Args=$valid.Replace('55461','5432'); Fail='PF_PROCESS'},
  @{Name='relative directory'; Args=$valid.Replace('C:/synthetic-preflight/postgres','postgres'); Fail='PF_PROCESS'},
  @{Name='attached D rejected'; Args=$valid.Replace('-D "','-D"'); Fail='PF_PROCESS'},
  @{Name='wrong pid'; Args=$valid; Pid=124; Fail='PF_PROCESS'},
  @{Name='wrong executable'; Args=$valid; Exe='C:\other\postgres.exe'; Fail='PF_PROCESS'},
  @{Name='missing executable'; Args=$valid; Exe=''; Fail='PF_PROCESS_METADATA_UNAVAILABLE'},
  @{Name='missing command line'; Args=''; Fail='PF_PROCESS_METADATA_UNAVAILABLE'},
  @{Name='missing pid'; Args=$valid; Pid=$null; Fail='PF_PROCESS_METADATA_UNAVAILABLE'},
  @{Name='no process'; Absent=$true; Fail='PF_PROCESS_METADATA_UNAVAILABLE'},
  @{Name='multiple processes'; Multiple=$true; Args=$valid; Fail='PF_PROCESS_METADATA_UNAVAILABLE'}
)
foreach ($case in $cases) {
  $server=[pscustomobject]@{ExecutablePath=$exe; CommandLine=($prefix+$case.Args); ProcessId=123}
  if ($case.ContainsKey('Exe')) {$server.ExecutablePath=$case.Exe}
  if ($case.ContainsKey('Pid')) {$server.ProcessId=$case.Pid}
  if ($case.Args -eq '') {$server.CommandLine=''}
  if ($case.Absent) {$server=$null}
  if ($case.Multiple) {$server=@($server,$server)}
  $actual=Test-PublicAclProcessIdentity $server 123 $dir
  if ($actual -cne $case.Fail) {throw "Validation failed: $($case.Name)"}
}
Write-Output "PASS: $($cases.Count) offline process cases; three PowerShell AST checks."
