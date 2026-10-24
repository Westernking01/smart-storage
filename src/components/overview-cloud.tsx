import { OverviewCloudView } from "./overview-cloud-view";
import Link from "next/link";
import { z } from "zod";
import Cloud from "@boxicons/react/Cloud";
import { cloudPageAccess, CloudAccessNotice } from "./cloud-page-access";
import { currentAccount, listFiles, rpc } from "@/lib/backend/operations";
import { AccountViewFence } from "./account-view-fence";
const sessions = z
  .array(
    z.object({
      id: z.uuid(),
      state: z.string(),
      heldBytes: z.string().regex(/^\d+$/),
    }),
  )
  .max(50);
export async function OverviewCloud() {
  const access = await cloudPageAccess();
  if (access.state !== "authenticated")
    return (
      <aside className="overview-cloud-panels">
        <section className="reference-panel">
          <div className="panel-heading">
            <h2>Your private cloud</h2>
            <Cloud width={22} height={22} />
          </div>
          <CloudAccessNotice state={access.state} />
          <Link href="/my-files">Open My Files ↗</Link>
        </section>
        <section className="reference-panel">
          <span className="eyebrow">From preparation to publication</span>
          <h2>You stay in control.</h2>
          <p className="panel-note">
            Prepare a file on this device. Upload its verified compressed
            payload from Compress when development cloud access is available.
          </p>
          <Link href="/compress">View prepared files ↗</Link>
        </section>
      </aside>
    );
  const [account, files, list] = await Promise.allSettled([
    currentAccount(access.account),
    listFiles(access.account, 5),
    rpc(access.account, "ss_sessions", {}, (v) => sessions.parse(v)),
  ]);
  return (
    <AccountViewFence key={access.account.id}>
      <OverviewCloudView
        usage={
          account.status === "fulfilled" ? (account.value.usage ?? null) : null
        }
        files={files.status === "fulfilled" ? files.value.files : null}
        sessions={list.status === "fulfilled" ? list.value : null}
      />
    </AccountViewFence>
  );
}
