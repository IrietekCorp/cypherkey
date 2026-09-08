import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SignupResult } from '../../../core/client/session';
import { createSync } from '../../../core/client/sync';
import type { BrowserApi } from '../../src/autofill';
import { API_BASE_URL } from '../../src/config';
import { THEME_KEY, type ThemeChoice, applyTheme, parseChoice } from '../../src/design/theme';
import { bindPopupLifecycle, createLockController } from '../../src/lock';
import { clearResume, loadResume, saveResume, sessionArea, touchResume } from '../../src/resume';
import { createExtensionSession } from '../../src/session';
import { USERNAME_KEY, localArea, memoryArea } from '../../src/storage';
import { createCache, indexedDbStore } from '../../src/sync/cache';
import { type SyncEngine, createSyncEngine } from '../../src/sync/engine';
import { createQueue } from '../../src/sync/queue';
import { decodeItem, encodeItem } from '../../src/vault/codec';
import type { VaultItem } from '../../src/vault/item';
import { Enroll } from './Enroll';
import { Feedback } from './Feedback';
import { Import } from './Import';
import { ItemEdit } from './ItemEdit';
import { ItemView } from './ItemView';
import { Onboarding } from './Onboarding';
import { Profile } from './Profile';
import { RecoveryKit } from './RecoveryKit';
import { Unlock } from './Unlock';
import { VaultList } from './VaultList';

/** A-12: bumped whenever the consent text changes, and recorded with the consent. */
const CONSENT_POLICY_VERSION = '2026-09-01';

/** Kept in step with `extension/wxt.config.ts`, so a report names the build it came from. */
const EXTENSION_VERSION = '0.1.0';

/**
 * The popup shell: Onboarding (M2-03) → Recovery Kit (M2-04) → Enrollment (M2-05) →
 * Unlock (M2-07) → Vault (M2-08).
 *
 * The vault is cached in IndexedDB as ciphertext and decrypted into memory for the
 * length of the unlock (M2-09).
 *
 * Session storage is `chrome.storage.local`. It was the in-memory area until M2-14
 * shipped the settings screen that can revoke device keys, and the deferral outlived
 * its reason: nothing survived closing the popup, so every open started onboarding
 * again -- for an account that already existed, on a product whose entire job is
 * remembering things. A-7 still decides *what* may persist; this only decides where.
 *
 * The half-made account the old note worried about is now the case that is handled:
 * signup completes, enrolment does not, and login says so -- `enrolled: false` with a
 * token to finish, so the popup resumes enrolment instead of stranding the account.
 */
export function App() {
  const [signedUp, setSignedUp] = useState<SignupResult | null>(null);
  const [kitSaved, setKitSaved] = useState(false);
  /** In memory only, for the length of this flow. A-7 permits no part of it on disk. */
  const [script, setScript] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [enrolled, setEnrolled] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  /**
   * Which account this popup is for, decided once from storage.
   *
   * `checking` until storage has answered: rendering onboarding first and correcting
   * afterwards would show "create an account" to someone who has one, which is the
   * exact confusion this fixes.
   */
  const [resume, setResume] = useState<'checking' | 'new' | 'returning'>('checking');
  /** Handed back by a login that found the account unenrolled, so it can be finished. */
  const [resumeToken, setResumeToken] = useState<string | null>(null);

  const [items, setItems] = useState<VaultItem[]>([]);
  const [engine, setEngine] = useState<SyncEngine | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewing, setViewing] = useState<VaultItem | null>(null);
  const [importing, setImporting] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  /**
   * Appearance, remembered.
   *
   * Light until the user says otherwise. `system` is one of the three things they can
   * ask for, not the absence of an answer -- defaulting to it would hand anyone on a dark
   * OS a dark product, which is the look this moved away from.
   */
  const [theme, setTheme] = useState<ThemeChoice>('light');
  const [editing, setEditing] = useState<{ kind: VaultItem['kind']; item?: VaultItem } | null>(
    null,
  );

  /**
   * The extension APIs, when they exist. Absent in the options page and in tests, and
   * autofill is then not offered rather than offered and broken.
   */
  const browserApi = useMemo(() => {
    const api = (globalThis as { chrome?: BrowserApi }).chrome;
    return api?.tabs !== undefined && api.scripting !== undefined ? api : null;
  }, []);

  /**
   * Opens the extension's own settings page, when there is one.
   *
   * Read from the global rather than through `BrowserApi`, which describes exactly what
   * autofill needs and is asserted that narrow. Absent in tests and in the options page
   * itself, where the button is simply not offered.
   */
  const optionsOpener = useMemo(() => {
    const runtime = (globalThis as { chrome?: { runtime?: { openOptionsPage?: () => void } } })
      .chrome?.runtime;
    return runtime?.openOptionsPage === undefined ? undefined : () => runtime.openOptionsPage?.();
  }, []);

  const { session, lockController } = useMemo(() => {
    const worker = new Worker(new URL('../../src/kdf-worker.ts', import.meta.url), {
      type: 'module',
    });
    const built = createExtensionSession({
      baseUrl: API_BASE_URL,
      area: localArea() ?? memoryArea(),
      worker,
    });
    return { session: built, lockController: createLockController({ session: built, worker }) };
  }, []);

  /**
   * A-5. The decrypted items are the reason this screen subscribes: `session.lock()`
   * zeroes the keys and knows nothing about the plaintext this component built from
   * them. Leaving a `VaultItem[]` alive after a lock would keep every password in
   * memory behind a locked door.
   */
  useEffect(() => {
    const off = lockController.onLock((reason) => {
      setItems([]);
      setViewing(null);
      setEditing(null);
      setUnlocked(false);
      setNotice('Locked.');
      /*
        Closing the popup is the one lock that does not end the session.

        The page is destroyed either way, so its keys go regardless -- what differs is
        whether the next open can resume. Idle, manual and suspend are the user or the
        clock saying "stop", and they clear the snapshot; a dismissed popup is not.

        Without this distinction the snapshot would be wiped every time the popup lost
        focus, which is the exact behaviour being fixed.
      */
      if (reason === 'popup-closed') return;
      const memory = sessionArea();
      if (memory !== null) void clearResume(memory);
    });
    const unbind = bindPopupLifecycle(lockController, window);
    return () => {
      off();
      unbind();
      lockController.dispose();
    };
  }, [lockController]);

  /**
   * Decrypts whatever the cache holds, into memory, for as long as the session is
   * unlocked (A-5). The cache itself never holds plaintext (A-7).
   */
  const refreshItems = useCallback(async () => {
    const cached = await createCache(indexedDbStore()).items();
    const decoded: VaultItem[] = [];
    for (const row of cached) {
      if (row.deletedAt != null) continue;
      try {
        decoded.push(await decodeItem(row.wire, session.vaultKey(), row.id));
      } catch {
        // A blob this key cannot open is one the engine will re-pull; showing a
        // broken row would be worse than showing none.
      }
    }
    setItems(decoded);
  }, [session]);

  /**
   * Builds the sync engine and shows what the vault holds.
   *
   * Shared by unlocking and by resuming a session that was already unlocked: a resumed
   * popup that skipped this would render a vault list that cannot save anything, because
   * the engine is what writes.
   */
  const openVault = useCallback(
    async (keyVersion: number) => {
      const store = indexedDbStore();
      const active = createSyncEngine({
        sync: createSync({
          request: session.authed(),
          token: session.tokens()?.accessToken ?? '',
        }),
        cache: createCache(store),
        queue: createQueue(store),
      });
      const { reset, pulled } = await active.open(keyVersion);
      setEngine(active);
      await refreshItems();
      if (reset) setNotice('Your vault key changed elsewhere, so this device re-synced.');
      else if (!pulled) setNotice('Offline. Showing what this device already had.');
    },
    [session, refreshItems],
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      const stored = await localArea()?.get(THEME_KEY);
      if (live && stored !== undefined) setTheme(parseChoice(stored[THEME_KEY]));
    })();
    return () => {
      live = false;
    };
  }, []);

  // One place writes `data-theme`; this keeps it following the choice, and the OS while
  // the choice is `system`.
  useEffect(() => applyTheme(document, window, theme), [theme]);

  /**
   * Is there an account on this device already?
   *
   * A device id means signup completed here at some point, and the username is what
   * `Unlock` logs in with. Both must be present: an id with no name would offer an
   * unlock nobody can complete.
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      const area = localArea();
      if (area === null) {
        if (live) setResume('new');
        return;
      }
      try {
        const found = await area.get(['cypherkey.device.id', USERNAME_KEY]);
        const id = found['cypherkey.device.id'];
        const name = found[USERNAME_KEY];
        if (!live) return;
        if (typeof id === 'string' && typeof name === 'string' && name !== '') {
          setUsername(name);
          /*
            An unlocked session may still be running. The popup is destroyed on close, so
            without this every open meant another Argon2id derivation and another rhythm
            sample -- correct, and unusable enough that nobody keeps it unlocked.

            The snapshot lives in `storage.session`, which the browser wipes on shutdown,
            and carries its own deadlines. A refusal is not an error: it just means the
            unlock screen, which is where this would have gone anyway.
          */
          const memory = sessionArea();
          if (memory !== null) {
            const result = await loadResume(memory, Date.now());
            if (!live) return;
            if (result.resumed && session.resumeFrom(result.stored.snapshot)) {
              await touchResume(memory, Date.now());
              setEnrolled(true);
              setUnlocked(true);
              setResume('returning');
              await openVault(result.stored.snapshot.keyVersion);
              return;
            }
          }
          setResume('returning');
        } else {
          setResume('new');
        }
      } catch {
        // Unreadable storage is not a reason to refuse to work: fall back to a fresh
        // start, which is what the user would get anyway.
        if (live) setResume('new');
      }
    })();
    return () => {
      live = false;
    };
    // `session` and `openVault` are both stable for the life of the popup: one is built
    // in a `useMemo` with no deps, the other a `useCallback` over it. Named so the rule
    // does not have to be silenced, and so a future change that makes either unstable
    // shows up here rather than as a resume that quietly stops happening.
  }, [session, openVault]);

  // Storage has not answered yet. One frame of nothing beats a frame of the wrong
  // screen, and the wrong screen here says "create an account" to someone who has one.
  if (resume === 'checking') {
    return <main className="p-4 font-sans text-sm text-neutral-600">Checking this device…</main>;
  }

  if (resume === 'new' && signedUp === null) {
    return (
      <Onboarding
        session={session}
        consentPolicyVersion={CONSENT_POLICY_VERSION}
        onComplete={(result, captured, name) => {
          setSignedUp(result);
          setScript(captured);
          setUsername(name);
          // So the next open knows whose account this is. The device keys core wrote
          // are useless to `Unlock` without a name to log in with.
          void localArea()?.set({ [USERNAME_KEY]: name });
        }}
        onHasAccount={(name) => {
          /*
            Straight to unlock. The device may not be registered here -- a login from an
            unknown device meets the X-3 step-up, which `Unlock` already handles -- and a
            username with no account fails there the way a wrong passphrase does, telling
            an onlooker nothing.
          */
          setUsername(name);
          void localArea()?.set({ [USERNAME_KEY]: name });
          setResume('returning');
        }}
      />
    );
  }

  if (signedUp !== null && !kitSaved) {
    return (
      <RecoveryKit
        recoveryCode={signedUp.recoveryCode}
        backupCodes={signedUp.backupCodes}
        onConfirmed={() => setKitSaved(true)}
      />
    );
  }

  /*
    Enrolment, from a fresh signup or resumed after the popup was closed.

    The token comes from signup when there is one, and otherwise from a login that found
    the account unenrolled. Without that second source, closing the popup between samples
    stranded the account: the passphrase still worked and login still passed, but nothing
    could authenticate to `/enroll/*` ever again.

    A returning device has to unlock first -- the token is issued by the login.
  */
  const enrollmentToken = signedUp?.enrollmentToken ?? resumeToken;
  if (!enrolled && enrollmentToken !== null && enrollmentToken !== undefined) {
    return (
      <Enroll
        session={session}
        enrollmentToken={enrollmentToken}
        {...(script === null ? {} : { script })}
        onBuilt={() => {
          setScript(null);
          setResumeToken(null);
          setEnrolled(true);
          /*
            Unlock again, even on the resumed path where the session is already open.
            Unlocking is what builds the sync engine, and a resumed enrolment reached
            this screen through a login that returned early without one -- landing
            straight in the vault would show a list that cannot save anything.

            It is also the first time the new profile is used, which is the moment the
            user should see their rhythm actually work.
          */
          setUnlocked(false);
        }}
      />
    );
  }

  if (!unlocked) {
    return (
      <Unlock
        session={session}
        username={username}
        strictness="medium"
        onUnlocked={async (keyVersion, enrollment) => {
          /*
            An unenrolled account goes back to enrolment rather than to the vault. There
            is no profile, so no rhythm has ever guarded anything here, and the vault is
            empty by construction -- opening it would present a finished account to
            someone who never finished one.
          */
          if (enrollment !== undefined) {
            setResumeToken(enrollment.token ?? null);
            setEnrolled(false);
            setUnlocked(true);
            return;
          }
          setEnrolled(true);
          setUnlocked(true);
          await openVault(keyVersion);
          // The unlock just happened, so both deadlines start now.
          const memory = sessionArea();
          const snapshot = session.exportSnapshot();
          if (memory !== null && snapshot !== null) {
            await saveResume(memory, snapshot, username, Date.now());
          }
        }}
        onForgotPassphrase={() => setUnlocked(false)}
      />
    );
  }

  const save = async (item: VaultItem) => {
    if (engine === null) return;
    const wire = await encodeItem(item, session.vaultKey());
    const existing = await createCache(indexedDbStore()).get(item.id);
    const result = await engine.save({
      id: item.id,
      version: existing?.version ?? 0,
      ciphertext: wire.ciphertext,
      nonce: wire.nonce,
      updatedAt: item.updatedAt,
    });
    setNotice(
      result.queued
        ? 'Saved on this device. It will sync when you are back online.'
        : result.conflicts.length > 0
          ? 'This item changed on another device. Open it to see the newer copy.'
          : null,
    );
    await refreshItems();
    setEditing(null);
    setViewing(null);
  };

  if (showProfile) {
    return (
      <Profile
        username={username}
        theme={theme}
        onTheme={(choice) => {
          setTheme(choice);
          void localArea()?.set({ [THEME_KEY]: choice });
        }}
        version={EXTENSION_VERSION}
        openSettings={optionsOpener}
        onLock={() => {
          // Straight through the controller that owns zeroing, so this cannot become a
          // second, subtly different way to lock (A-5).
          lockController.lock('manual');
          setShowProfile(false);
        }}
        onSignOut={async () => {
          await session.logout();
          setShowProfile(false);
          setUnlocked(false);
          setItems([]);
          setNotice('Signed out.');
        }}
        onBack={() => setShowProfile(false)}
      />
    );
  }

  if (importing) {
    return (
      <Import
        onImport={async (imported) => {
          // Saved one at a time through the engine, so each gets its own cursor and a
          // failure partway leaves the ones already stored intact.
          for (const item of imported) await save(item);
          setImporting(false);
        }}
        onCancel={() => setImporting(false)}
      />
    );
  }

  if (editing !== null) {
    return (
      <ItemEdit
        {...(editing.item === undefined ? {} : { item: editing.item })}
        kind={editing.kind}
        onSave={save}
        onCancel={() => setEditing(null)}
      />
    );
  }

  if (viewing !== null) {
    return (
      <ItemView
        item={viewing}
        onEdit={() => setEditing({ kind: viewing.kind, item: viewing })}
        onBack={() => setViewing(null)}
        {...(browserApi === null ? {} : { browser: browserApi })}
      />
    );
  }

  return (
    <>
      {notice !== null && (
        <p className="bg-neutral-100 px-4 pt-3 font-sans text-xs text-neutral-600">{notice}</p>
      )}
      <VaultList
        items={items}
        username={username}
        onOpen={setViewing}
        onAdd={(kind) => setEditing({ kind })}
        onProfile={() => setShowProfile(true)}
        onImport={() => setImporting(true)}
      />
      <Feedback version={EXTENSION_VERSION} userAgent={navigator.userAgent} />
    </>
  );
}
