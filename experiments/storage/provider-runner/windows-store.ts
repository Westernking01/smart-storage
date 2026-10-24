import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { RUN, USERS } from "./manifest.js";
import { outsideRepository, type Codec } from "./ledger.js";
import type { Credentials } from "./runner.js";

function powershell(script: string, input: string): string {
  if (process.platform !== "win32")
    throw new Error("WINDOWS_PRIVATE_STORE_REQUIRED");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      input,
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error("PRIVATE_STORE_FAILURE");
  return result.stdout.trim();
}
const aclCheck = `
$ErrorActionPreference='Stop'
$target=[Console]::In.ReadToEnd()
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl=Get-Acl -LiteralPath $target
$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
if ($rules.Count -ne 2) { throw 'ACL count' }
foreach($rule in $rules){if($rule.IdentityReference.Value -notin @($sid,'S-1-5-18') -or $rule.AccessControlType -ne 'Allow'){throw 'ACL identity'}}
'OK'
`;
export function privateFile(path: string, repository: string): string {
  const full = resolve(path);
  outsideRepository(full, repository);
  if (
    !existsSync(full) ||
    !lstatSync(full).isFile() ||
    lstatSync(full).isSymbolicLink()
  )
    throw new Error("PRIVATE_FILE_REQUIRED");
  if (powershell(aclCheck, full) !== "OK")
    throw new Error("PRIVATE_FILE_ACL_REQUIRED");
  return full;
}
export function canonicalDirectory(): string {
  if (process.platform !== "win32" || !process.env.USERPROFILE)
    throw new Error("WINDOWS_PRIVATE_STORE_REQUIRED");
  return join(process.env.USERPROFILE, `smart-storage-provider-${RUN}`);
}
export function createPrivateApproval(
  value: unknown,
  repository: string,
): string {
  if (process.platform !== "win32" || !process.env.USERPROFILE)
    throw new Error("WINDOWS_PRIVATE_STORE_REQUIRED");
  const directory = join(
    process.env.USERPROFILE,
    `smart-storage-renewal-approval-${randomUUID()}`,
  );
  outsideRepository(directory, repository);
  mkdirSync(directory);
  powershell(
    `
$ErrorActionPreference='Stop'
$target=[Console]::In.ReadToEnd()
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
foreach($identity in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl',[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))}
[IO.Directory]::SetAccessControl($target,$acl)
'OK'
`,
    directory,
  );
  if (powershell(aclCheck, directory) !== "OK")
    throw new Error("PRIVATE_DIRECTORY_ACL_REQUIRED");
  const file = join(directory, "approval.json");
  writeFileSync(file, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  return privateFile(file, repository);
}
export function initializePrivateDirectory(repository: string): string {
  const path = canonicalDirectory();
  outsideRepository(path, repository);
  if (existsSync(path))
    throw new Error("EXISTING_PRIVATE_DIRECTORY_DO_NOT_RESET");
  mkdirSync(path, { mode: 0o700 });
  powershell(
    `
$ErrorActionPreference='Stop'
$target=[Console]::In.ReadToEnd()
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[IO.Directory]::GetAccessControl($target,[Security.AccessControl.AccessControlSections]::Access)
$acl.SetAccessRuleProtection($true,$false)
foreach($rule in @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))){$acl.RemoveAccessRuleSpecific($rule)}
foreach($identity in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl',[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))}
[IO.Directory]::SetAccessControl($target,$acl)
'OK'
`,
    path,
  );
  checkDirectory(path, repository);
  return path;
}
export function checkDirectory(path: string, repository: string): void {
  outsideRepository(path, repository);
  if (
    resolve(path) !== resolve(canonicalDirectory()) ||
    !existsSync(path) ||
    !lstatSync(path).isDirectory()
  )
    throw new Error("CANONICAL_PRIVATE_LEDGER_REQUIRED");
  if (powershell(aclCheck, resolve(path)) !== "OK")
    throw new Error("PRIVATE_DIRECTORY_ACL_REQUIRED");
}
export class WindowsCodec implements Codec {
  encode(plain: string): string {
    return powershell(
      `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$bytes=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())
$cipher=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
$roundtrip=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
if([Convert]::ToBase64String($bytes) -ne [Convert]::ToBase64String($roundtrip)){throw 'DPAPI roundtrip'}
[Convert]::ToBase64String($cipher)
`,
      plain,
    );
  }
  decode(cipher: string): string {
    return powershell(
      `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd())
[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))
`,
      cipher,
    );
  }
}
export class ProtectedCredentials implements Credentials {
  constructor(
    private readonly file: string,
    private readonly repository: string,
    private readonly codec: Codec = new WindowsCodec(),
  ) {}
  get(actor: "A" | "B"): { id: string; email: string; password: string } {
    const file = privateFile(this.file, this.repository);
    const record = JSON.parse(
      this.codec.decode(readFileSync(file, "utf8")),
    ) as {
      status: string;
      accounts: {
        label: string;
        id: string;
        email: string;
        password: string;
      }[];
    };
    const a = record.accounts?.find((a) => a.label === actor);
    if (
      record.status !== "CREATED_AND_VERIFIED" ||
      !a ||
      a.id !== USERS[actor].id ||
      a.email !== USERS[actor].email ||
      typeof a.password !== "string" ||
      a.password.length < 24
    )
      throw new Error("PROTECTED_CREDENTIAL_MISMATCH");
    return { id: a.id, email: a.email, password: a.password };
  }
}
