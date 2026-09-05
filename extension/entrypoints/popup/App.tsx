/**
 * The popup shell. Screens land here in order: Onboarding (M2-03), Recovery Kit
 * (M2-04), Enrollment (M2-05), Unlock (M2-07), Vault (M2-08).
 *
 * The one thing this file does today is prove the scaffold: the session is built with
 * `chrome.storage` underneath and Argon2id in a Worker, and the WASM module starts
 * compiling the moment the popup opens rather than when the user presses submit.
 */
export function App() {
  return (
    <main className="p-4 font-sans text-sm">
      <h1 className="text-base font-semibold">CypherKey</h1>
      <p className="mt-1 text-neutral-600">Scaffold. Screens arrive with M2-03 onward.</p>
    </main>
  );
}
