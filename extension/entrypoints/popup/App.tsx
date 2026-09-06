import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SignupResult } from '../../../core/client/session';
import { createSync } from '../../../core/client/sync';
import type { BrowserApi } from '../../src/autofill';
import { bindPopupLifecycle, createLockController } from '../../src/lock';
import { createExtensionSession } from '../../src/session';
import { memoryArea } from '../../src/storage';
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
import { PartyTrick } from './PartyTrick';
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
 * length of the unlock (M2-09). Session storage is still the in-memory area rather than
 * `chrome.storage.local`: persisting device keys belongs with the settings screen that
 * can revoke them (M2-14), and until then a half-made account would leave the next
 * popup open in a state no screen recovers from.
 */
export function App() {
  const [signedUp, setSignedUp] = useState<SignupResult | null>(null);
  const [kitSaved, setKitSaved] = useState(false);
  /** In memory only, for the length of this flow. A-7 permits no part of it on disk. */
  const [script, setScript] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [enrolled, setEnrolled] = useState(false);
  const [unlocked, setUnlocked] = useState(false);

  const [items, setItems] = useState<VaultItem[]>([]);
  const [engine, setEngine] = useState<SyncEngine | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewing, setViewing] = useState<VaultItem | null>(null);
  const [importing, setImporting] = useState(false);
  /** X-7: offered once, straight after enrolment, while the idea is still new. */
  const [partyTrickShown, setPartyTrickShown] = useState(false);
  const [resolved, setResolved] = useState('');
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

  const { session, lockController } = useMemo(() => {
    const worker = new Worker(new URL('../../src/kdf-worker.ts', import.meta.url), {
      type: 'module',
    });
    const built = createExtensionSession({
      baseUrl: 'http://localhost:8787',
      area: memoryArea(),
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
    const off = lockController.onLock(() => {
      setItems([]);
      setViewing(null);
      setEditing(null);
      setUnlocked(false);
      setNotice('Locked.');
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
  const refresh = useCallback(async () => {
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

  if (signedUp === null) {
    return (
      <Onboarding
        session={session}
        consentPolicyVersion={CONSENT_POLICY_VERSION}
        onComplete={(result, captured, name, plain) => {
          setSignedUp(result);
          setScript(captured);
          setUsername(name);
          setResolved(plain);
        }}
      />
    );
  }

  if (!kitSaved) {
    return (
      <RecoveryKit
        recoveryCode={signedUp.recoveryCode}
        backupCodes={signedUp.backupCodes}
        onConfirmed={() => setKitSaved(true)}
      />
    );
  }

  if (!enrolled) {
    return (
      <Enroll
        session={session}
        enrollmentToken={signedUp.enrollmentToken}
        {...(script === null ? {} : { script })}
        onBuilt={() => {
          setScript(null);
          setEnrolled(true);
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
        onUnlocked={async (keyVersion) => {
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
          setUnlocked(true);
          await refresh();
          if (reset) setNotice('Your vault key changed elsewhere, so this device re-synced.');
          else if (!pulled) setNotice('Offline. Showing what this device already had.');
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
    await refresh();
    setEditing(null);
    setViewing(null);
  };

  /**
   * Offered once, immediately after enrolment. It needs the resolved passphrase, which
   * only exists in memory during this flow — after a reload there is nothing to show a
   * friend, which is the other reason it is a one-time screen.
   */
  if (!partyTrickShown && resolved.length > 0) {
    return (
      <PartyTrick
        session={session}
        resolved={resolved}
        strictness="medium"
        onDone={() => {
          setPartyTrickShown(true);
          setResolved('');
        }}
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
      <VaultList items={items} onOpen={setViewing} onAdd={(kind) => setEditing({ kind })} />
      <button
        type="button"
        onClick={() => setImporting(true)}
        className="self-start px-4 pb-3 font-sans text-xs text-neutral-500 underline"
      >
        Import from another manager
      </button>
      <Feedback version={EXTENSION_VERSION} userAgent={navigator.userAgent} />
    </>
  );
}
