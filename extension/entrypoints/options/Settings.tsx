import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthedRequest } from '../../../core/client/session';

/**
 * Settings (X-4, A-16).
 *
 * Every control here that *weakens* protection asks for the passphrase in the same
 * request (A-17). That is not a UI convention — the server refuses without it, because
 * a session token proves only that someone unlocked the popup at some point, and an
 * attacker holding an unlocked popup must not be able to switch the rhythm off.
 *
 * Turning protection back **on** asks for nothing. Requiring a factor to re-enable
 * would strand a user whose factor is unavailable in exactly the weakened state they
 * are trying to leave.
 */

export type Device = {
  id: string;
  name: string;
  platform: string;
  lastSeenAt: number | null;
  revokedAt: number | null;
  current?: boolean;
};

export type SettingsState = {
  biometricEnabled: boolean;
  pauseUntil: number | null;
  strictness: 'strict' | 'medium' | 'relaxed';
  keyVersion: number;
};

export type SettingsProps = {
  request: AuthedRequest;
  accessToken: string;
  /** Crossing into or out of Strict is a re-key, which only the popup can perform. */
  onRekeyRequested(target: 'strict' | 'medium' | 'relaxed'): void;
  now?: () => number;
};

const PAUSE_OPTIONS = [
  { label: '1 hour', ms: 60 * 60_000 },
  { label: '8 hours', ms: 8 * 60 * 60_000 },
  { label: '24 hours', ms: 24 * 60 * 60_000 },
];

export function Settings({
  request,
  accessToken,
  onRekeyRequested,
  now = Date.now,
}: SettingsProps) {
  const passphrase = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [s, d] = await Promise.all([
      request('GET', '/user/settings', undefined, accessToken),
      request('GET', '/user/devices', undefined, accessToken),
    ]);
    if (s.status === 200) {
      const body = s.body as {
        biometricEnabled: boolean;
        pauseUntil: number | null;
        thresholds?: { strictness: SettingsState['strictness'] };
        keyVersion: number;
      };
      setSettings({
        biometricEnabled: body.biometricEnabled,
        pauseUntil: body.pauseUntil,
        strictness: body.thresholds?.strictness ?? 'medium',
        keyVersion: body.keyVersion,
      });
    }
    if (d.status === 200) setDevices((d.body as { devices: Device[] }).devices ?? []);
  }, [request, accessToken]);

  // Reloads if the token changes, which is what a refresh looks like from here.
  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Sends a patch, attaching the passphrase when the change weakens protection.
   *
   * The field is read at send time and cleared straight after: it exists for the length
   * of one request, not for the length of the screen.
   */
  const patch = async (body: Record<string, unknown>, needsPassphrase: boolean) => {
    if (needsPassphrase) {
      const typed = passphrase.current?.value ?? '';
      if (typed.length === 0) {
        setMessage('Enter your passphrase to make this change.');
        return;
      }
      body.authHash = typed;
    }

    setBusy(true);
    try {
      const res = await request('PATCH', '/user/settings', body, accessToken);
      if (res.status === 403) {
        setMessage('That passphrase did not match.');
        return;
      }
      if (res.status !== 200) {
        setMessage(`That change was refused (${res.status}).`);
        return;
      }
      setMessage(null);
      await load();
    } finally {
      if (passphrase.current !== null) passphrase.current.value = '';
      setBusy(false);
    }
  };

  const revoke = async (device: Device) => {
    setBusy(true);
    try {
      const res = await request('DELETE', `/user/devices/${device.id}`, undefined, accessToken);
      setMessage(
        res.status === 200
          ? `${device.name} can no longer reach your vault.`
          : `Could not revoke that device (${res.status}).`,
      );
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (settings === null) {
    return <main className="p-6 font-sans text-sm">Loading…</main>;
  }

  const paused = settings.pauseUntil !== null && settings.pauseUntil > now();

  return (
    <main className="flex max-w-xl flex-col gap-6 p-6 font-sans text-sm">
      <h1 className="text-lg font-semibold">CypherKey settings</h1>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Your passphrase</h2>
        <p className="text-xs text-neutral-600">
          Changes that reduce protection need it typed here, in the same moment you make them. A
          session alone is not enough.
        </p>
        <input
          ref={passphrase}
          type="password"
          data-testid="passphrase"
          className="rounded border border-neutral-300 px-2 py-1"
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Rhythm</h2>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="biometric"
            checked={settings.biometricEnabled}
            disabled={busy}
            onChange={() =>
              patch({ biometricEnabled: !settings.biometricEnabled }, settings.biometricEnabled)
            }
          />
          <span>Require my typing rhythm to unlock</span>
        </label>
        {settings.biometricEnabled && (
          <p className="text-xs text-neutral-500">
            Turning this off leaves your passphrase as the only thing protecting the vault.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Pause</h2>
        <p className="text-xs text-neutral-600">
          {/* X-4: a bounded pause, for a broken wrist or a borrowed keyboard. */}
          Temporarily stop checking your rhythm — for an injury, or a keyboard that is not yours. It
          switches back on by itself.
        </p>
        {paused ? (
          <button
            type="button"
            data-testid="unpause"
            disabled={busy}
            onClick={() => patch({ pauseUntil: null }, false)}
            className="self-start rounded bg-neutral-900 px-2 py-1 text-white"
          >
            Resume rhythm checks now
          </button>
        ) : (
          <div className="flex gap-2">
            {PAUSE_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                data-testid={`pause-${option.ms}`}
                disabled={busy}
                onClick={() => patch({ pauseUntil: now() + option.ms }, true)}
                className="rounded border border-neutral-300 px-2 py-1"
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Strictness</h2>
        <div className="flex gap-2">
          {(['relaxed', 'medium', 'strict'] as const).map((level) => (
            <button
              key={level}
              type="button"
              data-testid={`strictness-${level}`}
              disabled={busy || level === settings.strictness}
              onClick={() =>
                // A-16: Medium ↔ Relaxed is a settings edit. Crossing into or out of
                // Strict changes the master key, so it is a re-key and belongs to the
                // popup, which can capture the passphrase and re-wrap.
                level === 'strict' || settings.strictness === 'strict'
                  ? onRekeyRequested(level)
                  : patch({ thresholds: { strictness: level } }, true)
              }
              className="rounded border border-neutral-300 px-2 py-1 disabled:bg-neutral-900 disabled:text-white"
            >
              {level}
            </button>
          ))}
        </div>
        <p data-testid="strict-warning" className="text-xs text-neutral-500">
          Strict folds your exact key sequence into the key itself, so switching to or from it
          re-keys your account. Your Recovery Kit keeps working; every other device has to sign in
          again.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Devices</h2>
        <ul data-testid="devices" className="flex flex-col gap-1">
          {devices.map((device) => (
            <li key={device.id} className="flex items-center justify-between gap-2">
              <span>
                {device.name}
                <span className="text-xs text-neutral-500"> · {device.platform}</span>
                {device.revokedAt !== null && (
                  <span className="text-xs text-neutral-500"> · revoked</span>
                )}
              </span>
              {device.revokedAt === null && device.current !== true && (
                <button
                  type="button"
                  data-testid={`revoke-${device.id}`}
                  disabled={busy}
                  onClick={() => revoke(device)}
                  className="rounded border border-neutral-300 px-2 py-1 text-xs"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {message !== null && (
        <p data-testid="message" className="text-xs text-neutral-700">
          {message}
        </p>
      )}
    </main>
  );
}
