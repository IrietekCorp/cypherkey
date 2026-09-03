# 03 — Experience Design

Sections are numbered X-n; tickets reference them.

## X-1. The Rhythm Light

**Principle:** no keystroke timing is captured unless the user can see the light. Like the LED on the Ray-Ban Meta glasses, but ours is also a delight feature.

**Behavior**
- A small dot inside the passphrase field's right edge. Idle: dim grey. Capturing: soft teal, and it **pulses once per keystroke** — the user literally sees their rhythm.
- On successful match, the dot blooms briefly. On grey band, it turns amber with a tooltip: "Your rhythm looks a little different today."
- Hovering shows: "CypherKey is measuring how you type. Nothing you type is stored — only timing. [Learn more]".
- The consent checkbox at signup is worded: *"I understand CypherKey measures the rhythm of my typing to protect my account, and I'll always see the Rhythm Light when it's listening."*

**Enforcement in code:** `core/biometrics/capture.ts` exports `startCapture(inputEl, lightEl)`. If `lightEl` is not present in the DOM and visible (`IntersectionObserver` + computed `visibility`), `startCapture` throws. The SDK exposes the same API; a service that hides the light gets no data. This is our answer to "silent" — we replaced it with **Progressive Enrollment** and a visible indicator.

## X-2. Enrollment and first run (target: under 3 minutes)

1. Install extension → welcome screen with the one-liner and the 2010 story in one sentence.
2. Choose a passphrase, typed twice exactly the same way — including any Phantom Keys (an extra letter you delete, a lone Escape, a tap of Ctrl). Show "12 keystrokes · 8 characters" so the user sees the phantoms counted. Strictness defaults to Medium; mention it exists, don't make them choose now. Show zxcvbn strength, require ≥ 3/4 and ≥ 12 chars. Suggest a 4-word passphrase generator ("correct-horse" style) — long passphrases give the rhythm model more features and are easier to type consistently.
3. **Recovery Kit** generated and shown *once*: a 32-character code plus a printable PDF (M2). The user must confirm "I saved it" and re-enter 4 characters of it to continue. This is the only way back without the passphrase.
4. **Teach the rhythm:** type the script 8 times — the whole thing, Phantom Keys included. The light pulses; a progress ring fills. Copy: "Type it the way you normally would — don't try to be perfect. Consistency beats speed." Backspaces are legitimate keystrokes and are never discarded. The retry condition is a **script mismatch**: if a sample's tokens don't match the canonical script exactly, the count doesn't advance (show "That one came out different — let's try again"). Tolerance is a login-time affordance only, so the profile is built from clean samples.
5. **The party trick:** "Want to see it work? Have a friend type your passphrase." A one-time demo screen that scores a sample against the fresh profile and shows the score without granting access. This is the moment people screenshot.
6. Done. Vault is empty; offer import from Bitwarden/1Password/Chrome CSV (M2).

## X-3. Graceful degradation ladder (fallback design)

The rule: **the user should never be locked out by their own body.** A bad day, a cast, a new keyboard, a laptop on a train — all of these must degrade gracefully, and every fallback should make the profile better.

| Score band | What the user sees | What happens |
|---|---|---|
| **Pass** | Light blooms, vault opens | Profile adapts (EMA) if score ≥ 0.70 |
| **Grey** (0.45–0.62) | Amber light. "Your rhythm looks different today. Type it once more." | Second sample scored. If the average clears the pass band → in. If not → step-up |
| **Step-up** | "Confirm it's you" with the user's configured factor: passkey (device biometric), TOTP, or one recovery code | On success: in, **and** the two samples are added to the profile (this is how the profile learns your new keyboard) |
| **Fail** (< 0.45) | Red light. "That didn't match your rhythm." Step-up offered after a 2s delay | Counts toward lockout (5 fails → 15 min, exponential). Email: "Someone typed your passphrase but didn't match your rhythm" — that email is a *feature*: it's the dark-web email inverted |
| **New device** | "New device — confirm it's you" | Always requires step-up regardless of score; registers device key on success |

**Step-up factors (user picks at least one at signup, default is passkey on the device if available, else recovery codes):**
- Passkey / platform authenticator (Touch ID, Windows Hello) — best UX
- TOTP (compatible with any authenticator)
- 10 one-time recovery codes
- Emergency contact (M5): trusted person can request access; 72-hour timer; user can veto

## X-4. Pause (your "turn it off temporarily" idea, made safe)

- Settings → "Pause my Rhythm" with durations: 24h, 7d, until I turn it back on.
- **Pausing requires a step-up** — otherwise an attacker with the passphrase just pauses it.
- While paused: the Rhythm Light is replaced by a small red "paused" badge in every unlock screen. Email confirmation sent. Auto-resume at the chosen time; on resume, the next 3 logins are treated as *enrollment refresh* samples (adds to profile, never blocks) so a user coming back from an injury retrains painlessly.
- The profile is never deleted by Pause.

## X-5. Recovery

- **Forgot passphrase:** Recovery Kit code → derives a key that unwraps `recoveryWrappedVaultKey` → user sets a new passphrase → vault re-wrapped, new enrollment (8 samples). Old devices are revoked.
- **Lost Recovery Kit but know passphrase:** regenerate the kit from settings (requires step-up).
- **Lost both:** account data is unrecoverable. Say so at signup, in the kit, and in the docs. This is what zero-knowledge means, and the audience we're courting respects it.
- **Rhythm changed permanently** (e.g., injury): step-up → Pause → 3 refresh logins → resume. Or re-enroll from settings.

## X-6. Vault and autofill (table stakes, must be flawless)

- Item types at launch: login, secure note. Cards/identities in M4. Passkeys in M4.
- Autofill: domain-matched, never on mismatched origin, punycode warning. Inline icon in fields; keyboard shortcut (`Ctrl/Cmd+Shift+L`).
- Generator: random and passphrase modes; one click into the field.
- Search: instant, fuzzy, offline.
- Import: Bitwarden JSON, 1Password 1PUX/CSV, Chrome CSV, KeePass XML. Export: encrypted JSON + plaintext CSV with a scary warning.
- Lock on idle (15 min default), lock on browser close, lock on lid close where detectable.

## X-7. Delight and differentiation features

| Feature | Milestone | Why it matters |
|---|---|---|
| **Phantom Keys** — corrections and extra keys are part of the secret; field shows only the resolved length | M1 | Unique; a leaked password from elsewhere is missing your phantoms |
| **Rhythm Light** with per-key pulse | M0 | Consent as delight; the thing people notice first |
| **Party Trick** (friend types your passphrase, fails) | M0 (web demo), M2 (in-app) | The viral loop; screenshots and short video |
| **Rhythm Signature** — a private waveform of your dwell/flight pattern in settings | M3 | "Show me my fingerprint." Private only; never shareable (it's biometric data) |
| **Consistency score** ("Your rhythm is 94% consistent") | M3 | Shareable stat that leaks nothing |
| **"Not your rhythm" email** | M2 | Turns the scary dark-web email into a "we stopped them" email |
| **Precision Mode** | M3 | For Hall-effect/rapid-trigger keyboard users: tighter threshold, per-device profiles, "gamer badge." Warn that it raises grey-band frequency |
| **Per-device profiles** | M3 | Laptop vs mechanical keyboard rhythm differ; the profile knows which device you're on |
| **Breach check** (HIBP k-anonymity) | M4 | The button that says "your password leaked — but your login didn't" |
| **One-command self-host** | M1 | `docker compose up`; screenshot-worthy for r/selfhosted |
| **CLI unlock** (`cypherkey get github`) with rhythm in raw-mode terminal | M4 | Devs; the SSH-timing-attack (Song et al., 2001) nod in the README |
| **Rhythm-gated passkeys** | M5 | Unique: passkey only released if the rhythm matches |

## X-8. Copy tone

Plain, warm, a little playful, never smug. Explain limits in one sentence, never in a wall. Example error: "That didn't match your rhythm. Try again, or confirm it's you another way." Example success on first enrollment: "That's your rhythm. We'll remember it — not what you typed, just how."

## X-9. Accessibility

- Rhythm requires typing; users who use dictation or on-screen keyboards can turn it off permanently (not just Pause) with a step-up factor as their second factor. Say this in onboarding.
- Light has an ARIA live region announcing "listening" / "matched" / "different today."
- Reduced-motion: the pulse becomes a color change.

## X-10. Strictness slider

Settings → Security → "How strict should CypherKey be?" Three stops:
- **Strict** — "Every keystroke must match, including Phantom Keys, and they become part of your master key. Best protection, least forgiving." (Changing to this shows: "This rotates your master key. Keep your Recovery Kit nearby.")
- **Medium** (default) — "A small slip in your Phantom Keys is forgiven — about one per ten keystrokes. A wrong passphrase never is."
- **Relaxed** — "More forgiving on both rhythm and Phantom Keys. Good while you're on a new keyboard or recovering."

Any change requires a step-up. The Rhythm Light tooltip reflects the level ("Medium strictness").
