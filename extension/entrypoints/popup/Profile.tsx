export type ProfileProps = {
  username: string;
  /** What this build is, so a bug report names it. */
  version: string;
  /** Absent outside the extension, where there is no options page to open. */
  openSettings?: (() => void) | undefined;
  onLock(): void;
  onSignOut(): void;
  onBack(): void;
};

/**
 * Who this vault belongs to, and the two ways out of it.
 *
 * Deliberately thin. The full settings screen (M2-14) already owns Strictness, device
 * revocation and the Recovery Kit, and it lives in the options page where there is room
 * for the consequences to be explained -- crossing into Strict re-keys the account, and
 * revoking a device is not undoable. Reproducing any of that in a 360px popup would mean
 * either two places to change one setting or an explanation too short to be honest.
 *
 * So this answers what a person opens a profile for: which account am I in, on what
 * build, and how do I get out.
 */
export function Profile({
  username,
  version,
  openSettings,
  onLock,
  onSignOut,
  onBack,
}: ProfileProps) {
  return (
    <main
      className="ck-app flex h-full flex-col"
      style={{ padding: 'var(--ck-s4)', gap: 'var(--ck-s4)' }}
    >
      <header className="flex items-center">
        <button
          type="button"
          data-testid="back"
          onClick={onBack}
          className="btn btn-ghost ck-small"
        >
          ← Vault
        </button>
      </header>

      <div className="flex items-center" style={{ gap: 'var(--ck-s3)' }}>
        <span
          aria-hidden="true"
          className="grid shrink-0 place-items-center"
          style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            background: 'var(--ck-accent-900)',
            color: 'var(--ck-accent-300)',
            border: '1px solid var(--ck-accent-700)',
            fontWeight: 500,
          }}
        >
          {(username.trim()[0] ?? '?').toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-col">
          <span data-testid="profile-username" className="ck-h1 truncate">
            {username.trim() === '' ? 'This device' : username}
          </span>
          <span className="ck-small ck-muted">Signed in on this device</span>
        </div>
      </div>

      <dl
        className="flex flex-col"
        style={{
          gap: 'var(--ck-s2)',
          paddingTop: 'var(--ck-s3)',
          borderTop: '1px solid var(--ck-border)',
        }}
      >
        <div className="flex justify-between" style={{ gap: 'var(--ck-s3)' }}>
          <dt className="ck-small ck-muted">Rhythm</dt>
          {/*
            Stated, not editable. Strictness changes the KDF input, so crossing into
            Strict re-keys the account (A-16) -- a decision that needs the room the
            settings screen has, not a control in a popup.
          */}
          <dd data-testid="profile-rhythm" className="ck-small">
            Measured on unlock
          </dd>
        </div>
        <div className="flex justify-between" style={{ gap: 'var(--ck-s3)' }}>
          <dt className="ck-small ck-muted">Version</dt>
          <dd data-testid="profile-version" className="ck-small ck-num font-mono">
            {version}
          </dd>
        </div>
      </dl>

      <div
        className="flex flex-col"
        style={{
          gap: 'var(--ck-s2)',
          paddingTop: 'var(--ck-s3)',
          borderTop: '1px solid var(--ck-border)',
        }}
      >
        {openSettings !== undefined && (
          <button
            type="button"
            data-testid="open-settings"
            onClick={openSettings}
            className="card-row flex-col items-start"
            style={{ border: '1px solid var(--ck-border)', gap: 2 }}
          >
            <span>Settings</span>
            <span className="ck-small ck-muted">Strictness, devices and your Recovery Kit</span>
          </button>
        )}

        <button
          type="button"
          data-testid="lock"
          onClick={onLock}
          className="card-row flex-col items-start"
          style={{ border: '1px solid var(--ck-border)', gap: 2 }}
        >
          <span>Lock now</span>
          <span className="ck-small ck-muted">
            Keys are wiped from memory; this device stays registered.
          </span>
        </button>

        <button
          type="button"
          data-testid="sign-out"
          onClick={onSignOut}
          className="card-row flex-col items-start"
          style={{ border: '1px solid var(--ck-fail)', gap: 2, color: 'var(--ck-fail-text)' }}
        >
          <span>Sign out</span>
          {/* Costly actions state their price in the same breath (guide §08). */}
          <span className="ck-small" style={{ color: 'var(--ck-fail-text)', opacity: 0.85 }}>
            Clears this device. You’ll re-enrol your rhythm here.
          </span>
        </button>
      </div>
    </main>
  );
}
