import { AccountViewFence } from "./account-view-fence";
import { cloudPageAccess, CloudAccessNotice } from "./cloud-page-access";
import { currentAccount, listFiles } from "@/lib/backend/operations";
import { readCursor, type OwnedFile } from "@/lib/backend/files";
import { CloudAnalyticsView } from "./cloud-analytics-view";
export async function CloudAnalytics() {
  const access = await cloudPageAccess();
  if (access.state !== "authenticated")
    return <CloudAccessNotice state={access.state} />;
  let account: Awaited<ReturnType<typeof currentAccount>>;
  const files: OwnedFile[] = [];
  let truncated = false;
  try {
    account = await currentAccount(access.account);
    let cursor: ReturnType<typeof readCursor> = null;
    do {
      const page = await listFiles(access.account, 50, cursor);
      files.push(...page.files);
      cursor = readCursor(page.next ?? undefined);
      if (files.length >= 1000 && cursor) {
        truncated = true;
        break;
      }
    } while (cursor);
  } catch {
    return (
      <div className="reference-panel state-notice" role="alert">
        <h2>Storage summary unavailable</h2>
        <p>
          Cloud accounting or file metadata could not be loaded. No usage is
          assumed.
        </p>
      </div>
    );
  }
  if (!account.usage)
    return (
      <div className="reference-panel state-notice">
        Account quota is unavailable. Account setup is required.
      </div>
    );
  return (
    <AccountViewFence key={access.account.id}>
      <CloudAnalyticsView
        files={files.map((f) => ({
          ...f,
          originalBytes: BigInt(f.originalBytes),
          encodedBytes: f.encodedBytes === null ? null : BigInt(f.encodedBytes),
          storedBytes: f.storedBytes === null ? null : BigInt(f.storedBytes),
        }))}
        usage={{
          quotaBytes: BigInt(account.usage.quotaBytes),
          storedBytes: BigInt(account.usage.storedBytes),
          reservedBytes: BigInt(account.usage.reservedBytes),
        }}
        truncated={truncated}
      />
    </AccountViewFence>
  );
}
