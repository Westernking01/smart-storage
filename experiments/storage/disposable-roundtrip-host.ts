import { execFileSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { request } from "node:https";
import { z } from "zod";
export { ordinarySessionBridge } from "./disposable-ordinary-session";
import { preflightDisposableUpload } from "./disposable-upload-contract";
import {
  disposableSupabaseAdapter,
  executeDisposableRoundTrip,
  filesystemAttemptClaims,
} from "./disposable-roundtrip-executor";

const qualification = z
  .object({
    claimDirectory: z.string().min(1),
    retentionAndPowerLossReview: z.string().trim().min(1),
    effectivePermissionsReview: z.string().trim().min(1),
    ordinarySessionVerificationReview: z.string().trim().min(1),
  })
  .strict();

/** Read-only ACL inspection. Never creates, repairs or clears the live fence. */
export async function inspectClaimDirectory(directory: string) {
  if (process.platform !== "win32" || resolve(directory) !== directory)
    throw Error("WINDOWS_ABSOLUTE_CLAIM_DIRECTORY_REQUIRED");
  if ((await realpath(directory)).toLowerCase() !== directory.toLowerCase())
    throw Error("CLAIM_DIRECTORY_ALIAS");
  for (let path = directory; ; path = dirname(path)) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw Error("CLAIM_DIRECTORY_REPARSE_OR_NON_DIRECTORY");
    if (dirname(path) === path) break;
  }
  // Literal quoting; no profile, environment-file lookup or credential reader.
  const literal = directory.replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; $p='${literal}'; $a=Get-Acl -LiteralPath $p; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; [pscustomobject]@{sid=$sid;owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$a.AreAccessRulesProtected;rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();rights=[int]$_.FileSystemRights} })} | ConvertTo-Json -Depth 4 -Compress`;
  const acl = z
    .object({
      sid: z.string(),
      owner: z.string(),
      protected: z.boolean(),
      rules: z.array(
        z.object({ sid: z.string(), type: z.string(), rights: z.number() }),
      ),
    })
    .parse(
      JSON.parse(
        execFileSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          {
            encoding: "utf8",
            windowsHide: true,
            timeout: 10000,
          },
        ),
      ),
    );
  const allowed = new Set([acl.sid, "S-1-5-18", "S-1-5-32-544"]);
  if (
    !acl.protected ||
    acl.owner !== acl.sid ||
    acl.rules.some((r) => r.type !== "Allow" || !allowed.has(r.sid)) ||
    !acl.rules.some(
      (r) => r.sid === acl.sid && (r.rights & 0x1f01ff) === 0x1f01ff,
    )
  )
    throw Error("CLAIM_DIRECTORY_ACL_UNQUALIFIED");
  return { restricted: true as const };
}

/** Operator composition only. No login, refresh, token files, env fallback,
 * arbitrary provider, endpoint, cleanup or retry. External verification must
 * authenticate the session, not merely decode its JWT or label an attestation.
 * Reviews are operator evidence references, not independent proof. */
export async function runOperatorRoundTrip(input: {
  config: unknown;
  source: Uint8Array<ArrayBuffer>;
  encoded: Uint8Array<ArrayBuffer>;
  authorization: unknown;
  qualification: unknown;
  verifiedSession: () => Promise<unknown>;
}) {
  const source = input.source.slice(),
    encoded = input.encoded.slice();
  const config = await preflightDisposableUpload(input.config, source, encoded);
  const review = qualification.parse(input.qualification);
  if (
    review.effectivePermissionsReview !==
    config.createReadPermissionReviewReference
  )
    throw Error("PERMISSION_REVIEW_MISMATCH");
  await inspectClaimDirectory(review.claimDirectory);
  const claim = filesystemAttemptClaims(review.claimDirectory);
  return executeDisposableRoundTrip({
    config,
    source,
    encoded,
    authorization: input.authorization,
    session: input.verifiedSession,
    claimOnce: async (key) => {
      await inspectClaimDirectory(review.claimDirectory);
      return claim(key);
    },
    provider: disposableSupabaseAdapter(request),
  });
}
