import { useEffect, useMemo, useState } from 'react';
import type { SignupResult } from '../../../core/client/session';
import { createExtensionSession } from '../../src/session';
import { memoryArea } from '../../src/storage';
import { type ItemWire, decodeItem, encodeItem } from '../../src/vault/codec';
import type { VaultItem } from '../../src/vault/item';
import { Enroll } from './Enroll';
import { ItemEdit } from './ItemEdit';
import { ItemView } from './ItemView';
import { Onboarding } from './Onboarding';
import { RecoveryKit } from './RecoveryKit';
import { Unlock } from './Unlock';
import { VaultList } from './VaultList';

/** A-12: bumped whenever the consent text changes, and recorded with the consent. */
const CONSENT_POLICY_VERSION = '2026-09-01';

/**
 * The popup shell: Onboarding (M2-03) → Recovery Kit (M2-04) → Enrollment (M2-05) →
 * Unlock (M2-07) → Vault (M2-08).
 *
 * Storage is still the in-memory area rather than `chrome.storage.local`, and the vault
 * lives in React state rather than IndexedDB. Both are M2-09's job. Persisting a
 * half-made account before there is a sync engine would leave the next popup open in a
 * state no screen can recover from.
 */
export function App() {
  const [signedUp, setSignedUp] = useState<SignupResult | null>(null);
  const [kitSaved, setKitSaved] = useState(false);
  /** In memory only, for the length of this flow. A-7 permits no part of it on disk. */
  const [script, setScript] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [enrolled, setEnrolled] = useState(false);
  const [unlocked, setUnlocked] = useState(false);

  /** Items are held encrypted and decoded for display — the shape M2-09 will persist. */
  const [vault, setVault] = useState<Record<string, ItemWire>>({});
  const [items, setItems] = useState<VaultItem[]>([]);
  const [viewing, setViewing] = useState<VaultItem | null>(null);
  const [editing, setEditing] = useState<{ kind: VaultItem['kind']; item?: VaultItem } | null>(
    null,
  );

  const session = useMemo(() => {
    const worker = new Worker(new URL('../../src/kdf-worker.ts', import.meta.url), {
      type: 'module',
    });
    return createExtensionSession({
      baseUrl: 'http://localhost:8787',
      area: memoryArea(),
      worker,
    });
  }, []);

  // Plaintext exists only here, and only while unlocked (A-5).
  useEffect(() => {
    if (!unlocked) return;
    let cancelled = false;
    void (async () => {
      const decoded = await Promise.all(
        Object.entries(vault).map(([id, wire]) => decodeItem(wire, session.vaultKey(), id)),
      );
      if (!cancelled) setItems(decoded);
    })();
    return () => {
      cancelled = true;
    };
  }, [vault, unlocked, session]);

  if (signedUp === null) {
    return (
      <Onboarding
        session={session}
        consentPolicyVersion={CONSENT_POLICY_VERSION}
        onComplete={(result, captured, name) => {
          setSignedUp(result);
          setScript(captured);
          setUsername(name);
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
        onUnlocked={() => setUnlocked(true)}
        onForgotPassphrase={() => setUnlocked(false)}
      />
    );
  }

  const save = async (item: VaultItem) => {
    const wire = await encodeItem(item, session.vaultKey());
    setVault((current) => ({ ...current, [item.id]: wire }));
    setEditing(null);
    setViewing(null);
  };

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
      />
    );
  }

  return <VaultList items={items} onOpen={setViewing} onAdd={(kind) => setEditing({ kind })} />;
}
