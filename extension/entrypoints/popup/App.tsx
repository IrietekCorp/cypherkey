import { useMemo, useState } from 'react';
import type { SignupResult } from '../../../core/client/session';
import { createExtensionSession } from '../../src/session';
import { memoryArea } from '../../src/storage';
import { Onboarding } from './Onboarding';
import { RecoveryKit } from './RecoveryKit';

/** A-12: bumped whenever the consent text changes, and recorded with the consent. */
const CONSENT_POLICY_VERSION = '2026-09-01';

/**
 * The popup shell. Screens land here in order: Onboarding (M2-03), Recovery Kit
 * (M2-04), Enrollment (M2-05), Unlock (M2-07), Vault (M2-08).
 *
 * Storage is still the in-memory area rather than `chrome.storage.local`: nothing here
 * has a server to talk to yet, so persisting a half-made account would leave the next
 * popup open in a state no screen can recover from. M2-07 wires the real one.
 */
export function App() {
  const [signedUp, setSignedUp] = useState<SignupResult | null>(null);
  const [kitSaved, setKitSaved] = useState(false);

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

  if (signedUp === null) {
    return (
      <Onboarding
        session={session}
        consentPolicyVersion={CONSENT_POLICY_VERSION}
        onComplete={setSignedUp}
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

  return (
    <main className="flex flex-col gap-2 p-4 font-sans text-sm">
      <h1 className="text-base font-semibold">Next: teach it your rhythm</h1>
      <p className="text-xs text-neutral-600">
        Enrollment is M2-05. Eight samples build the profile that recognises how you type.
      </p>
    </main>
  );
}
