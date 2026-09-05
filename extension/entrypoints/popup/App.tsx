import { useMemo, useState } from 'react';
import type { SignupResult } from '../../../core/client/session';
import { createExtensionSession } from '../../src/session';
import { memoryArea } from '../../src/storage';
import { Enroll } from './Enroll';
import { Onboarding } from './Onboarding';
import { RecoveryKit } from './RecoveryKit';
import { Unlock } from './Unlock';

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
  /** In memory only, for the length of this flow. A-7 permits no part of it on disk. */
  const [script, setScript] = useState<string | null>(null);
  const [enrolled, setEnrolled] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [username, setUsername] = useState('');
  const [message, setMessage] = useState<string | null>(null);

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

  return (
    <main className="flex flex-col gap-2 p-4 font-sans text-sm">
      <h1 className="text-base font-semibold">You are set up</h1>
      <p className="text-xs text-neutral-600">The unlock screen is M2-07 and the vault is M2-08.</p>
    </main>
  );
}
