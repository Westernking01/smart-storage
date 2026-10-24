# Task 1.4B.2A — approval ACL reconciliation

Classification: **ACL RECONCILED**. Local-only reconciliation; provider execution remains unapproved. No real credentials were decrypted, provider requests made, ledger initialized or budgets reset.

## Exact finding

Inspected the existing external p14b-first-wave-approval.json and its parent in the normal Windows Admin context at 2026-10-12T15:38:25.8887202Z. Owner of both: DESKTOP-G12NE65\Admin; current SID S-1-5-21-3058023354-1746979206-3201508519-1000. Approval contents and opaque confirmation ID were never printed.

Rejected ACE: **Allow / ReadAndExecute, Synchronize / S-1-5-21-3058023354-1746979206-3201508519-1002**, resolved to **DESKTOP-G12NE65\CodexSandboxUsers**. Get-LocalGroup independently confirms it is a local group. The parent had an explicit ContainerInherit,ObjectInherit ACE; the file inherited it alongside Admin and SYSTEM FullControl entries. File inheritance was enabled; parent inheritance was protected. The file's three entries violated the documented current-user/SYSTEM-only security model. This is additional group access, not the required SYSTEM principal; the validator correctly rejected it. Group membership and the mechanism that originally added the ACE were not audited, so no individual reader or credential exposure is claimed.

## File-only correction and integrity

The existing approval had not expired. Expiry remains exactly **2026-10-12T16:04:01.423Z**, **17:04:01.423 Africa/Lagos**. No expiry extension, replacement candidate, new run or approval-content edit was made.

Used supported .NET FileSecurity access-only APIs to disable file inheritance, remove inherited/remaining access entries and install exactly two explicit Allow FullControl entries: current Admin SID and NT AUTHORITY\SYSTEM (S-1-5-18). Owner unchanged. The file is now inheritance-protected; no Everyone, Users, Authenticated Users or CodexSandboxUsers ACE remains on it. Approval bytes before/after were compared in memory and are identical; hashes/confirmation values were not printed. Project, bucket, manifest, purposes, confirmation ID and expiry are consequently preserved byte-for-byte.

The parent directory's access SDDL is byte-identical before/after. Its CodexSandboxUsers entry remains; changing it was unnecessary for protecting this existing file and could affect unrelated child files. No other file/directory ACL was modified. Future file creation in that parent still requires explicitly establishing a private file ACL rather than trusting inheritance; no future approval creation is authorized here.

## Actual checks

| Check                                                      | Result                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------- |
| Existing file privateFile validator in normal user context | Passed unchanged validator                              |
| Readback ACL                                               | Protected; exactly two explicit permitted Allow entries |
| Approval content comparison                                | Identical bytes                                         |
| Parent-directory ACL comparison                            | Unchanged                                               |
| Native Windows Vitest file                                 | Four tests passed, 30.61 seconds                        |
| Runner unit Vitest file                                    | 34 tests passed, 6.61 seconds                           |
| Canonical experiment ledger                                | Absent; budget still unspent                            |
| Documentation formatting and local links                   | Passed                                                  |

Native tests use only disposable fake credentials and temporary ledgers; they do not decrypt the real credential store. TypeScript/lint were not rerun because no runner/application source changed; this task changes one external file ACL and documentation only. Source security checks were neither weakened nor modified.

## Stop boundary

Provider stages remain zero, allocation attempts zero, attempted provider body bytes zero, remote objects/TUS resources created by this run zero. First-wave allowance remains **3 / 6,325,536**; whole-run allowance **12 / 33,554,432** is still not additional execution permission. No cleanup, sign-in, TUS/object operation, provider query, policy/configuration change or later-phase work occurred during this task.

The approval was unexpired at inspection/correction; it automatically expires at the unchanged time above. File ACL validity is not execution authorization and does not renew that expiry. Stop and await separate approval before resuming Task 1.4B.2. If expiry is reached first, report it and obtain separate authorization before any replacement; never auto-renew or reuse an expired record. ADR-041 remains a release blocker.
