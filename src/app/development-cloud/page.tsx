import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { CloudAnalytics } from "@/components/cloud-analytics";
export const dynamic = "force-dynamic";
export default function Page() {
  return (
    <AppShell>
      <div className="page-heading">
        <div>
          <p className="type-caption">Your private account</p>
          <h1 className="type-page">Cloud storage</h1>
          <p>Everything accounted for. A clearer view of your space.</p>
        </div>
      </div>
      <Suspense
        fallback={
          <div className="analytics-skeleton" role="status">
            Loading cloud analytics…
          </div>
        }
      >
        <CloudAnalytics />
      </Suspense>
    </AppShell>
  );
}
