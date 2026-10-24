import { root } from "./transfer-browser";
import { AppFrame } from "../../src/components/app-frame";
import { LocalTransfer } from "../../src/components/local-transfer";
import { CloudRecordBrowser } from "../../src/components/cloud-record-browser";
import { CloudAnalyticsView } from "../../src/components/cloud-analytics-view";
import { OverviewCloudView } from "../../src/components/overview-cloud-view";
import { AuthLayout } from "../../src/components/auth-layout";
import { AuthForm } from "../../src/components/auth-form";
import { VolumeFiles } from "../../src/components/volume-files";
import {
  AccountSettings,
  AccountSettingsState,
} from "../../src/components/account-settings";
import "@fontsource/geist/latin-400.css";
import "@fontsource/geist/latin-500.css";
import "@fontsource/geist/latin-600.css";
import "tailwindcss/preflight.css";
import "../../src/styles/tokens.css";
import "../../src/styles/foundation.css";
import "../../src/styles/reference-ui.css";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const F = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const listing = [
  {
    id: F,
    name: "fixture.txt",
    originalName: "fixture.txt",
    originalMime: "text/plain",
    bytes: "100",
    originalBytes: "16000",
    createdAt: "2026-10-24T00:00:00Z",
    category: "document",
    revision: 0,
  },
];
const usage = {
  quotaBytes: "1048576",
  storedBytes: "428000",
  reservedBytes: "65536",
};
const analyticsFiles = [
  {
    id: F,
    displayName: "browser-fixture.txt",
    category: "document",
    originalBytes: BigInt(1600000),
    encodedBytes: BigInt(96000),
    storedBytes: BigInt(100000),
  },
  {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    displayName: "image-fixture.bin",
    category: "image",
    originalBytes: BigInt(640000),
    encodedBytes: BigInt(256000),
    storedBytes: BigInt(260000),
  },
  {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    displayName: "archive-fixture.bin",
    category: "archive",
    originalBytes: BigInt(320000),
    encodedBytes: BigInt(64000),
    storedBytes: BigInt(68000),
  },
];
Object.assign(window, {
  designHarness: {
    mount(page: string, enabled = true) {
      const paths: Record<string, string> = {
        overview: "/",
        files: "/my-files",
        compress: "/compress",
        recent: "/recent-files",
        local: "/local-storage",
        cloud: "/development-cloud",
        account: "/account",
        "account-loading": "/account",
        "account-error": "/account",
      };
      if (["login", "register", "reset", "update"].includes(page)) {
        history.replaceState(
          {},
          "",
          page === "login"
            ? "/login"
            : page === "register"
              ? "/register"
              : page === "reset"
                ? "/forgot-password"
                : "/update-password",
        );
        const title =
          page === "login"
            ? "Welcome back"
            : page === "register"
              ? "Create your account"
              : page === "reset"
                ? "Recover account access"
                : "Choose a new password";
        root.render(
          <AuthLayout
            title={title}
            intro="Make space for your files, without losing a byte."
          >
            <AuthForm
              mode={page as "login" | "register" | "reset" | "update"}
              enabled={enabled}
            />
          </AuthLayout>,
        );
        return;
      }
      history.replaceState({}, "", paths[page] ?? "/");
      root.render(
        <AppFrame cloudConfigured>
          {page.startsWith("account") ? (
            page === "account" ? (
              <AccountSettings
                id={A}
                email={enabled ? "fixture@example.invalid" : null}
                profileUnavailable={!enabled}
              />
            ) : (
              <AccountSettingsState
                state={page === "account-loading" ? "loading" : "error"}
              />
            )
          ) : page === "overview" ? (
            <div className="overview-layout">
              <LocalTransfer ownerId={A} title="Overview" />
              <OverviewCloudView
                usage={usage}
                files={[
                  {
                    id: F,
                    displayName: "fixture.txt",
                    createdAt: "2026-10-24T00:00:00Z",
                  },
                ]}
                sessions={[]}
              />
            </div>
          ) : page === "files" ? (
            <>
              <div className="page-heading">
                <div>
                  <p className="type-caption">Private cloud workspace</p>
                  <h1 className="type-page">My files</h1>
                  <p>
                    A place for every file. Every original, ready to restore.
                  </p>
                </div>
              </div>
              <CloudRecordBrowser files={listing} recent={false} ownerId={A} />
            </>
          ) : page === "cloud" ? (
            <>
              <div className="page-heading">
                <div>
                  <p className="type-caption">Your private account</p>
                  <h1 className="type-page">Cloud storage</h1>
                  <p>Everything accounted for. A clearer view of your space.</p>
                </div>
              </div>
              <CloudAnalyticsView
                files={analyticsFiles}
                usage={{
                  quotaBytes: BigInt(usage.quotaBytes),
                  storedBytes: BigInt(usage.storedBytes),
                  reservedBytes: BigInt(usage.reservedBytes),
                }}
              />
            </>
          ) : (
            <LocalTransfer
              ownerId={A}
              title={
                page === "compress"
                  ? "Compress"
                  : page === "recent"
                    ? "Recent files"
                    : "Local storage"
              }
              mode={
                page === "compress"
                  ? "compress"
                  : page === "recent"
                    ? "recent"
                    : "storage"
              }
            />
          )}
          {page === "compress" && (
            <VolumeFiles ownerId={A} cloudScope="offline" uploadsOnly />
          )}
        </AppFrame>,
      );
    },
    emptyCloud() {
      root.render(
        <AppFrame cloudConfigured>
          <h1 className="type-page">Cloud storage</h1>
          <CloudAnalyticsView
            files={[]}
            usage={{
              quotaBytes: BigInt(0),
              storedBytes: BigInt(0),
              reservedBytes: BigInt(0),
            }}
          />
        </AppFrame>,
      );
    },
    unavailableOverview() {
      root.render(
        <AppFrame cloudConfigured>
          <h1 className="type-page">Overview</h1>
          <OverviewCloudView usage={null} files={null} sessions={null} />
        </AppFrame>,
      );
    },
  },
});
