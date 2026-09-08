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
    <main className="flex h-full flex-col gap-4 p-4 font-sans text-sm">
      <header className="flex items-center gap-2">
        <button
          type="button"
          data-testid="back"
          onClick={onBack}
          className="rounded px-1.5 py-0.5 text-neutral-600 hover:bg-neutral-100"
        >
          ← Vault
        </button>
      </header>

      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid h-11 w-11 place-items-center rounded-full bg-neutral-900 text-base font-semibold text-white"
        >
          {(username.trim()[0] ?? '?').toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-col">
          <span data-testid="profile-username" className="truncate text-base font-semibold">
            {username.trim() === '' ? 'This device' : username}
          </span>
          <span className="text-xs text-neutral-500">Signed in on this device</span>
        </div>
      </div>

      <dl className="flex flex-col gap-2 border-t border-neutral-200 pt-3 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-neutral-500">Rhythm</dt>
          {/*
            Stated, not editable. Strictness changes the KDF input, so crossing into
            Strict re-keys the account (A-16) -- a decision that needs the room the
            settings screen has, not a control in a popup.
          */}
          <dd data-testid="profile-rhythm" className="text-neutral-800">
            Measured on unlock
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-neutral-500">Version</dt>
          <dd data-testid="profile-version" className="font-mono text-neutral-800">
            {version}
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-2 border-t border-neutral-200 pt-3">
        {openSettings !== undefined && (
          <button
            type="button"
            data-testid="open-settings"
            onClick={openSettings}
            className="rounded border border-neutral-300 px-2 py-1 text-left hover:bg-neutral-100"
          >
            Settings
            <span className="block text-xs text-neutral-500">
              Strictness, devices and your Recovery Kit
            </span>
          </button>
        )}

        <button
          type="button"
          data-testid="lock"
          onClick={onLock}
          className="rounded border border-neutral-300 px-2 py-1 text-left hover:bg-neutral-100"
        >
          Lock now
          <span className="block text-xs text-neutral-500">
            Keys are wiped from memory; this device stays registered.
          </span>
        </button>

        <button
          type="button"
          data-testid="sign-out"
          onClick={onSignOut}
          className="rounded border border-rose-300 px-2 py-1 text-left text-rose-800 hover:bg-rose-50"
        >
          Sign out
          <span className="block text-xs text-rose-700/80">
            Ends the session on the server. You will need your passphrase and rhythm to get back in.
          </span>
        </button>
      </div>
    </main>
  );
}
