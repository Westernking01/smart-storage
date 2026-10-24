import Link from "next/link";
import User from "@boxicons/react/User";
import Lock from "@boxicons/react/Lock";
import Shield from "@boxicons/react/Shield";
import File from "@boxicons/react/File";
import ArrowUpRight from "@boxicons/react/ArrowUpRight";
import { AccountControls } from "./account-controls";
import { CopyAccountId } from "./copy-account-id";
import { AccountViewFence } from "./account-view-fence";

export function AccountSettingsHeading() {
  return (
    <div className="page-heading">
      <div>
        <h1 className="type-page">Account &amp; security</h1>
        <p>Your identity, password and signed-in session.</p>
      </div>
    </div>
  );
}
export function AccountSettings({
  id,
  email,
  profileUnavailable = false,
}: {
  id: string;
  email: string | null;
  profileUnavailable?: boolean;
}) {
  return (
    <section className="account-settings">
      <AccountSettingsHeading />
      <div className="account-settings-grid">
        <section
          className="reference-panel account-profile"
          aria-labelledby="profile-heading"
        >
          <div className="panel-heading">
            <h2 id="profile-heading">Account profile</h2>
            <span className="account-state-badge">Signed in</span>
          </div>
          <AccountViewFence key={id}>
            <div className="account-profile-summary">
              <span className="settings-avatar">
                <User width={27} height={27} aria-hidden="true" />
              </span>
              <div>
                <h3>Your private account</h3>
                <p>{email ?? "Email unavailable"}</p>
              </div>
              {email && (
                <span className="account-email-status">
                  <Shield width={15} height={15} aria-hidden="true" />
                  Verified email
                </span>
              )}
            </div>
            {profileUnavailable && (
              <p className="account-profile-note">
                Email details could not be loaded. Your account identity remains
                verified.
              </p>
            )}
            <div className="settings-identity-row">
              <div>
                <strong>Account identity</strong>
                <p>Your unique Smart Storage account ID.</p>
              </div>
              <CopyAccountId key={id} id={id} />
            </div>
          </AccountViewFence>
        </section>
        <section
          className="reference-panel settings-security"
          aria-labelledby="security-heading"
        >
          <div className="panel-heading">
            <h2 id="security-heading">
              <Lock width={18} height={18} aria-hidden="true" />
              Security
            </h2>
          </div>
          <h3>Password</h3>
          <p>Update the password you use to access Smart Storage.</p>
          <Link
            className="ui-button ui-button--secondary"
            href="/update-password"
          >
            <Lock width={16} height={16} aria-hidden="true" />
            Change password
            <ArrowUpRight width={16} height={16} aria-hidden="true" />
          </Link>
        </section>
        <section
          className="reference-panel settings-session"
          aria-labelledby="session-heading"
        >
          <div className="panel-heading">
            <h2 id="session-heading">
              <Shield width={18} height={18} aria-hidden="true" />
              Session management
            </h2>
          </div>
          <h3>Sign out of Smart Storage</h3>
          <p>Local processing stops when you sign out.</p>
          <div className="account-sign-out">
            <AccountControls />
          </div>
        </section>
        <nav
          className="settings-workspace-links"
          aria-label="Account workspace links"
        >
          <Link href="/my-files">
            <File width={18} height={18} aria-hidden="true" />
            <span>My files</span>
            <ArrowUpRight width={16} height={16} aria-hidden="true" />
          </Link>
          <Link href="/app">
            <User width={18} height={18} aria-hidden="true" />
            <span>Open workspace</span>
            <ArrowUpRight width={16} height={16} aria-hidden="true" />
          </Link>
        </nav>
      </div>
    </section>
  );
}
export function AccountSettingsState({
  state,
}: {
  state: "loading" | "error";
}) {
  return (
    <section className="account-settings">
      <AccountSettingsHeading />
      {state === "loading" ? (
        <div
          className="account-loading reference-panel"
          role="status"
          aria-busy="true"
        >
          <span className="settings-skeleton" />
          <span className="settings-skeleton" />
          <span className="settings-skeleton" />
          Loading account details…
        </div>
      ) : (
        <div className="reference-panel settings-error" role="alert">
          <h2>Account details unavailable</h2>
          <p>
            Your account details could not be verified. No account information
            is shown.
          </p>
          <Link className="ui-button ui-button--secondary" href="/account">
            Reload account
          </Link>
          <Link href="/login?next=/account">Sign in</Link>
        </div>
      )}
    </section>
  );
}
