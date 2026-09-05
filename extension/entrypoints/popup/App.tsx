import { useMemo, useState } from 'react';
import type { SignupResult } from '../../../core/client/session';
import { createExtensionSession } from '../../src/session';
import { memoryArea } from '../../src/storage';
import { Onboarding } from './Onboarding';

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
  const [done, setDone] = useState<SignupResult | null>(null);

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

  if (done !== null) {
    return (
      <main className="flex flex-col gap-2 p-4 font-sans text-sm">
        <h1 className="text-base font-semibold">Save your Recovery Kit</h1>
        <p className="text-xs text-neutral-600">
          The Recovery Kit screen is M2-04. Until then, this is the code that would be shown once
          and never again.
        </p>
        <code className="rounded bg-neutral-100 p-2 text-xs break-all">{done.recoveryCode}</code>
      </main>
    );
  }

  return (
    <Onboarding
      session={session}
      consentPolicyVersion={CONSENT_POLICY_VERSION}
      onComplete={setDone}
    />
  );
}
