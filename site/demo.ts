import './styles.css';

import { startCapture } from '../core/biometrics/capture';
import { extractFeatures } from '../core/biometrics/features';
import { buildProfile, score } from '../core/biometrics/score';
import type { Profile } from '../core/biometrics/score';
import {
  describeEvents,
  eventsToScript,
  readableToken,
  scriptLength,
  scriptsEqual,
} from '../core/biometrics/script';
import type { FeatureVector, KeyEvent } from '../core/biometrics/types';
import { type Strictness, rhythmBands } from '../core/crypto/phantom';

type DemoState = 'idle' | 'enrolling' | 'built' | 'challenge_friend' | 'challenge_you' | 'results';

const SAMPLE_PHRASES = [
  'correct horse battery staple',
  'blue ocean waves under starlight',
  'sunflower seeds in summer wind',
  'quantum encryption guards every key',
  'whispering forest morning dew',
];

// App State
let currentState: DemoState = 'idle';
let targetPassphrase = 'correct horse battery staple';

/**
 * The canonical script from the first enrollment sample (docs/02 A-14). With Phantom
 * Keys on, this is what every later sample — and the friend's attempt — must
 * reproduce. It holds the phantoms; `targetPassphrase` holds only what survives them.
 */
let canonicalScript: string | null = null;

/** Live keystroke count for the current sample, since the field only shows characters. */
let keystrokesTyped = 0;

/** X-3 lets the friend try more than once; an attacker would. Best score is what counts. */
const FRIEND_ATTEMPTS = 3;
let friendAttempts: number[] = [];

/**
 * A-16 Strictness, adjustable live. Bands are derived from the recorded scores, so
 * moving the control re-judges the same attempts without anyone typing again.
 */
let strictness: Strictness = 'medium';

/** Which of the two setup options is active. Nothing else decides the phrase. */
let setupChoice: 'random' | 'own' = 'random';
let enrollmentSamples: FeatureVector[] = [];
let userProfile: Profile | null = null;
let friendScoreResult: { score: number; band: 'pass' | 'grey' | 'fail' } | null = null;
let youScoreResult: { score: number; band: 'pass' | 'grey' | 'fail' } | null = null;

// Active capture handles
let activeCapture: { stop(): KeyEvent[]; cancel(): void } | null = null;

// DOM Elements
const stateLabel = document.getElementById('state-label') as HTMLElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;

// Step Sections
const stepSetup = document.getElementById('step-setup') as HTMLElement;
const stepEnroll = document.getElementById('step-enroll') as HTMLElement;
const stepBuilt = document.getElementById('step-built') as HTMLElement;
const stepChallengeFriend = document.getElementById('step-challenge-friend') as HTMLElement;
const stepChallengeYou = document.getElementById('step-challenge-you') as HTMLElement;
const stepResults = document.getElementById('step-results') as HTMLElement;

// Step 1: Setup Elements
const inputPassphraseSetup = document.getElementById('input-passphrase-setup') as HTMLInputElement;
const btnSamplePhrase = document.getElementById('btn-sample-phrase') as HTMLButtonElement;
const btnBeginEnroll = document.getElementById('btn-begin-enroll') as HTMLButtonElement;
const setupError = document.getElementById('setup-error') as HTMLElement;

// Step 2: Enroll Elements
const enrollCurrentStep = document.getElementById('enroll-current-step') as HTMLElement;
const enrollTargetPhrase = document.getElementById('enroll-target-phrase') as HTMLElement;
const enrollDotsContainer = document.getElementById('enroll-dots-container') as HTMLElement;
const enrollKeyCounter = document.getElementById('enroll-key-counter') as HTMLElement;
const inputEnroll = document.getElementById('input-enroll') as HTMLInputElement;
const rhythmLight = document.getElementById('rhythm-light') as HTMLElement;
const optionRandom = document.getElementById('option-random') as HTMLButtonElement;
const optionOwn = document.getElementById('option-own') as HTMLButtonElement;
const randomPhraseDisplay = document.getElementById('random-phrase-display') as HTMLElement;
const friendAttemptCounter = document.getElementById('friend-attempt-counter') as HTMLElement;
const friendAttemptHistory = document.getElementById('friend-attempt-history') as HTMLElement;
const friendAttemptList = document.getElementById('friend-attempt-list') as HTMLElement;
const btnFriendGiveUp = document.getElementById('btn-friend-give-up') as HTMLButtonElement;
const btnTestAnotherFriend = document.getElementById(
  'btn-test-another-friend',
) as HTMLButtonElement;
const youTargetPhrase = document.getElementById('you-target-phrase') as HTMLElement;
const strictnessHintYou = document.getElementById('strictness-hint-you') as HTMLElement;
const strictnessHintResults = document.getElementById('strictness-hint-results') as HTMLElement;
const friendOutcome = document.getElementById('friend-outcome') as HTMLElement;
const youOutcome = document.getElementById('you-outcome') as HTMLElement;
const debugPanel = document.getElementById('debug-panel') as HTMLElement;
const debugRows = document.getElementById('debug-rows') as HTMLElement;
const phantomReadout = document.getElementById('phantom-script-readout') as HTMLElement;
const phantomCounts = document.getElementById('phantom-counts') as HTMLElement;
const phantomDetail = document.getElementById('phantom-detail') as HTMLElement;
const rhythmMiniBars = document.getElementById('rhythm-mini-bars') as HTMLElement;
const enrollFeedback = document.getElementById('enroll-feedback') as HTMLElement;
const btnSubmitEnrollSample = document.getElementById(
  'btn-submit-enroll-sample',
) as HTMLButtonElement;

// Step 3: Built Elements
const profileStatLen = document.getElementById('profile-stat-len') as HTMLElement;
const profileStatDim = document.getElementById('profile-stat-dim') as HTMLElement;
const btnGotoChallenge = document.getElementById('btn-goto-challenge') as HTMLButtonElement;

// Step 4: Challenge Friend Elements
const friendTargetPhrase = document.getElementById('friend-target-phrase') as HTMLElement;
const friendKeyCounter = document.getElementById('friend-key-counter') as HTMLElement;
const inputChallengeFriend = document.getElementById('input-challenge-friend') as HTMLInputElement;
const rhythmLightFriend = document.getElementById('rhythm-light-friend') as HTMLElement;
const friendMiniBars = document.getElementById('friend-mini-bars') as HTMLElement;
const friendFeedback = document.getElementById('friend-feedback') as HTMLElement;
const btnSubmitFriendChallenge = document.getElementById(
  'btn-submit-friend-challenge',
) as HTMLButtonElement;

// Step 5: Challenge You Elements
const youKeyCounter = document.getElementById('you-key-counter') as HTMLElement;
const inputChallengeYou = document.getElementById('input-challenge-you') as HTMLInputElement;
const rhythmLightYou = document.getElementById('rhythm-light-you') as HTMLElement;
const youMiniBars = document.getElementById('you-mini-bars') as HTMLElement;
const youFeedback = document.getElementById('you-feedback') as HTMLElement;
const btnSubmitYouChallenge = document.getElementById(
  'btn-submit-you-challenge',
) as HTMLButtonElement;

// Step 6: Results Elements
const friendScoreDisplay = document.getElementById('friend-score-display') as HTMLElement;
const friendBandBadge = document.getElementById('friend-band-badge') as HTMLElement;
const friendExplanation = document.getElementById('friend-explanation') as HTMLElement;
const youScoreDisplay = document.getElementById('you-score-display') as HTMLElement;
const youBandBadge = document.getElementById('you-band-badge') as HTMLElement;
const youExplanation = document.getElementById('you-explanation') as HTMLElement;
const btnRetestYou = document.getElementById('btn-retest-you') as HTMLButtonElement;
const btnNewPassphrase = document.getElementById('btn-new-passphrase') as HTMLButtonElement;

// Email form elements
const emailForm = document.getElementById('email-form') as HTMLFormElement;
const emailConfirmation = document.getElementById('email-confirmation') as HTMLElement;

/**
 * Triggers a visual pulse animation on a Rhythm Light element and companion wave bars.
 */
function triggerPulse(lightEl: HTMLElement, barsEl?: HTMLElement) {
  lightEl.classList.remove('rhythm-pulse-active');
  void lightEl.offsetWidth; // force reflow
  lightEl.classList.add('rhythm-pulse-active');

  if (barsEl) {
    const bars = barsEl.querySelectorAll('.rhythm-wave-bar');
    for (const bar of bars) {
      const scale = 0.5 + Math.random() * 1.3;
      (bar as HTMLElement).style.transform = `scaleY(${scale})`;
      setTimeout(() => {
        (bar as HTMLElement).style.transform = 'scaleY(0.5)';
      }, 150);
    }
  }
}

/**
 * Updates the visual state label and shows/hides appropriate containers.
 */
function setState(newState: DemoState) {
  currentState = newState;
  stateLabel.textContent = newState.replace('_', ' ');

  // Hide all sections first
  stepSetup.classList.add('hidden');
  stepEnroll.classList.add('hidden');
  stepBuilt.classList.add('hidden');
  stepChallengeFriend.classList.add('hidden');
  stepChallengeYou.classList.add('hidden');
  stepResults.classList.add('hidden');

  // Cancel any active capture
  if (activeCapture) {
    activeCapture.cancel();
    activeCapture = null;
  }

  switch (newState) {
    case 'idle':
      stepSetup.classList.remove('hidden');
      inputPassphraseSetup.focus();
      break;

    case 'enrolling':
      stepEnroll.classList.remove('hidden');
      enrollTargetPhrase.textContent = targetPassphrase;
      renderEnrollDots();
      prepareEnrollSample();
      break;

    case 'built':
      stepBuilt.classList.remove('hidden');
      if (userProfile) {
        profileStatLen.textContent = `${userProfile.len} characters`;
        profileStatDim.textContent = `${userProfile.means.length} features (3n + 5)`;
      }
      break;

    case 'challenge_friend':
      stepChallengeFriend.classList.remove('hidden');
      friendTargetPhrase.textContent = targetPassphrase;
      renderFriendAttempts();
      renderStrictness();
      prepareChallengeFriend();
      break;

    case 'challenge_you':
      stepChallengeYou.classList.remove('hidden');
      // Shown again on purpose: after watching someone else type it, nobody should
      // have to remember the phrase they were handed minutes ago.
      youTargetPhrase.textContent = targetPassphrase;
      renderStrictness();
      prepareChallengeYou();
      break;

    case 'results':
      stepResults.classList.remove('hidden');
      renderStrictness();
      renderResults();
      break;
  }
}

/**
 * Renders the 8 progress indicator pills for enrollment.
 */
function renderEnrollDots() {
  enrollDotsContainer.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const pill = document.createElement('span');
    const isCompleted = i < enrollmentSamples.length;
    const isCurrent = i === enrollmentSamples.length;

    let styles = 'bg-slate-100 border-slate-300 text-slate-400';
    if (isCompleted) {
      styles = 'bg-teal-600 border-teal-600 text-white font-bold shadow-xs';
    } else if (isCurrent) {
      styles = 'bg-white border-teal-600 text-teal-700 ring-2 ring-teal-500/20 font-bold';
    }

    pill.className = `w-6 h-6 rounded-full border text-[10px] flex items-center justify-center transition-all duration-200 ${styles}`;
    pill.textContent = isCompleted ? '✓' : String(i + 1);
    enrollDotsContainer.appendChild(pill);
  }
}

/**
 * Prepares the input and capture listener for an enrollment sample.
 */
/**
 * Resets the field for the next sample.
 *
 * `keepFeedback` exists because every rejection path used to call this immediately
 * after showing its reason, which wiped the message before anyone could read it — the
 * sample was refused and the screen said nothing at all.
 */
function prepareEnrollSample(keepFeedback = false) {
  if (activeCapture) {
    activeCapture.cancel();
    activeCapture = null;
  }

  inputEnroll.value = '';
  keystrokesTyped = 0;
  enrollKeyCounter.textContent = '0 keystrokes · 0 characters';
  if (!keepFeedback) {
    enrollFeedback.className = 'text-xs font-medium px-3 py-2 rounded-lg hidden';
    enrollFeedback.textContent = '';
  }
  enrollCurrentStep.textContent = String(enrollmentSamples.length + 1);

  rhythmLight.className = 'rhythm-light-dot listening';

  try {
    activeCapture = startCapture(inputEnroll, rhythmLight, {
      onPulse: () => {
        triggerPulse(rhythmLight, rhythmMiniBars);
        // Keystrokes and characters diverge the moment a Phantom Key is typed, which
        // is the whole idea — the field shows the resolved length, the counter does not.
        keystrokesTyped++;
        enrollKeyCounter.textContent = `${keystrokesTyped} keystrokes · ${inputEnroll.value.length} characters`;
      },
    });
  } catch (err) {
    console.error('Failed to start capture:', err);
  }

  setTimeout(() => inputEnroll.focus(), 50);
}

/**
 * Diagnostics, enabled with `?debug=1`.
 *
 * Scope is deliberate. This lives in the demo and nowhere else: `core/` gains no debug
 * hook, so nothing here can reach the extension, which imports `core/` and never this
 * file. It holds only the throwaway phrase the visitor just invented on a page with no
 * account and no network, and the page already prints that phrase on screen. It never
 * writes to storage, never logs to the console (AGENTS forbids logging key material),
 * and never sends anything anywhere — the demo has no server to send it to.
 *
 * The extension must never grow an equivalent. Real feature vectors and real scripts
 * are exactly what A-4.1 and A-14 say must not be surfaced, and a runtime flag would
 * be the wrong control there: it would have to be stripped at build time.
 */
const DEBUG = new URLSearchParams(window.location.search).get('debug') === '1';

/** Bands a score at the current Strictness (A-16), not at a hardcoded default. */
function bandFor(value: number): 'pass' | 'grey' | 'fail' {
  const { pass, grey } = rhythmBands(strictness);
  if (value >= pass) return 'pass';
  if (value >= grey) return 'grey';
  return 'fail';
}

/** Renders control tokens so a phantom is visible rather than invisible. */
function readableScript(script: string): string {
  return [...script].map(readableToken).join('');
}

function debugNote(stage: string, outcome: string, detail = '', trace = '') {
  if (!DEBUG) return;
  const row = document.createElement('div');
  row.className = outcome === 'accepted' ? 'text-emerald-800' : 'text-rose-800';
  row.textContent = `${stage.padEnd(8)} ${outcome.padEnd(9)} ${detail}`;
  debugRows.appendChild(row);
  if (trace !== '') {
    // The key sequence as captured. Keys and order only — never timings, and this is
    // a throwaway demo phrase the page already prints in full.
    const traceRow = document.createElement('div');
    traceRow.className = 'text-amber-700 pl-4 break-all';
    traceRow.textContent = trace;
    debugRows.appendChild(traceRow);
  }
  debugRows.scrollTop = debugRows.scrollHeight;
}

/** Human wording for each reason a sample can be void (A-14.1). */
const SCRIPT_ERROR_COPY: Record<string, string> = {
  unsupported_key: 'That used a key we can’t time — arrows, Tab and paste all end a sample.',
  unsupported_combo: 'Ctrl, Alt and ⌘ combinations end a sample. A lone tap is fine.',
  focus_lost: 'The field lost focus mid-sample. Let’s try that one again.',
  malformed: 'That sample came out garbled. Let’s try again.',
};

/** Shows "12 keystrokes · 8 characters" — the count A-14 says the user should see. */
function showScriptCounts(script: string, resolved: string) {
  const keystrokes = scriptLength(script);
  phantomCounts.textContent = `${keystrokes} keystrokes · ${resolved.length} characters`;
  const phantoms = keystrokes - resolved.length;
  phantomDetail.textContent =
    phantoms > 0
      ? `  —  ${phantoms} phantom ${phantoms === 1 ? 'key' : 'keys'} that never reach the passphrase`
      : '  —  no phantom keys yet';
  phantomReadout.classList.remove('hidden');
}

function showFeedback(el: HTMLElement, tone: 'warn' | 'ok', message: string) {
  el.className =
    tone === 'ok'
      ? 'text-xs font-medium px-3 py-2 rounded-lg bg-teal-50 text-teal-800 border border-teal-200'
      : 'text-xs font-medium px-3 py-2 rounded-lg bg-amber-50 text-amber-800 border border-amber-200';
  el.textContent = message;
  el.classList.remove('hidden');
}

/**
 * Turns a capture into something scoreable, or explains why it is not.
 *
 * Three outcomes, in the order the real server checks them (A-14.3): the sample was
 * void, the resolved text was wrong, or the script did not match the enrolled one.
 * Only after all three does a rhythm score mean anything.
 */
function readAttempt(
  events: ReturnType<NonNullable<typeof activeCapture>['stop']>,
):
  | { message: string }
  | { phantomMismatch: true }
  | { phantomMismatch: false; features: FeatureVector } {
  const script = eventsToScript(events);
  if ('error' in script) {
    return { message: SCRIPT_ERROR_COPY[script.error] ?? 'Please try again.' };
  }
  if (script.resolved !== targetPassphrase) {
    return { message: 'That doesn’t resolve to the target passphrase. Type the exact phrase.' };
  }
  if (canonicalScript !== null && !scriptsEqual(canonicalScript, script.script)) {
    return { phantomMismatch: true };
  }

  const features = extractFeatures(events, scriptLength(script.script));
  if ('error' in features) {
    return { message: SCRIPT_ERROR_COPY[features.error] ?? 'Please type once more.' };
  }
  return { phantomMismatch: false, features };
}

/**
 * Handles submission of one enrollment sample.
 */
function handleEnrollSampleSubmit() {
  if (!activeCapture) return;

  const events = activeCapture.stop();
  activeCapture = null;

  // A-14.1 decides what counted as a keystroke, including the phantoms.
  const script = eventsToScript(events);
  if ('error' in script) {
    debugNote('enroll', 'rejected', `${script.error}: ${script.detail}`, describeEvents(events));
    showFeedback(
      enrollFeedback,
      'warn',
      `${SCRIPT_ERROR_COPY[script.error] ?? 'Please try again.'} (${script.detail})`,
    );
    prepareEnrollSample(true);
    return;
  }

  showScriptCounts(script.script, script.resolved);

  // The resolved text is what a normal form would have received — phantoms and all
  // the corrections have already been applied.
  if (script.resolved !== targetPassphrase) {
    debugNote(
      'enroll',
      'rejected',
      `resolved ${JSON.stringify(script.resolved)} != ${JSON.stringify(targetPassphrase)}`,
      describeEvents(events),
    );
    showFeedback(
      enrollFeedback,
      'warn',
      'That doesn’t resolve to the target passphrase. Corrections are fine — the end result has to match.',
    );
    prepareEnrollSample(true);
    return;
  }

  // A-14: enrollment tolerates nothing. The first sample fixes the script; the rest
  // must reproduce it exactly, phantoms included, so the profile is built from one.
  if (canonicalScript === null) {
    canonicalScript = script.script;
  } else if (!scriptsEqual(canonicalScript, script.script)) {
    debugNote(
      'enroll',
      'rejected',
      `script ${readableScript(script.script)} != enrolled ${readableScript(canonicalScript)}`,
      describeEvents(events),
    );
    showFeedback(
      enrollFeedback,
      'warn',
      'Same passphrase, different keystrokes. Every sample has to include the same Phantom Keys.',
    );
    prepareEnrollSample(true);
    return;
  }

  const result = extractFeatures(events, scriptLength(script.script));

  if ('error' in result) {
    showFeedback(enrollFeedback, 'warn', SCRIPT_ERROR_COPY[result.error] ?? 'Length mismatch.');
    prepareEnrollSample(true);
    return;
  }

  debugNote(
    'enroll',
    'accepted',
    `#${enrollmentSamples.length + 1}/8  ${readableScript(script.script)}  ${scriptLength(script.script)}k/${script.resolved.length}c`,
  );
  enrollmentSamples.push(result);
  renderEnrollDots();

  // Bloom animation
  rhythmLight.className = 'rhythm-light-dot pass';

  if (enrollmentSamples.length >= 8) {
    userProfile = buildProfile(enrollmentSamples);
    setTimeout(() => setState('built'), 400);
  } else {
    showFeedback(
      enrollFeedback,
      'ok',
      `✓ Sample ${enrollmentSamples.length} recorded! Next sample...`,
    );
    // Restart immediately, keeping the tick on screen. Waiting 350 ms left a window
    // where the field was live but nothing was listening, so anything typed in it was
    // silently dropped and its keyup landed in the next sample.
    prepareEnrollSample(true);
  }
}

/**
 * Prepares the friend challenge input and capture.
 */
function prepareChallengeFriend(keepFeedback = false) {
  if (activeCapture) {
    activeCapture.cancel();
    activeCapture = null;
  }

  inputChallengeFriend.value = '';
  friendKeyCounter.textContent = `0 / ${targetPassphrase.length} keys`;
  if (!keepFeedback) {
    friendFeedback.className = 'text-xs font-medium px-3 py-2 rounded-lg hidden';
    friendFeedback.textContent = '';
  }
  rhythmLightFriend.className = 'rhythm-light-dot listening';

  try {
    activeCapture = startCapture(inputChallengeFriend, rhythmLightFriend, {
      onPulse: () => {
        triggerPulse(rhythmLightFriend, friendMiniBars);
        friendKeyCounter.textContent = `${inputChallengeFriend.value.length} / ${targetPassphrase.length} keys`;
      },
    });
  } catch (err) {
    console.error('Failed to start friend capture:', err);
  }

  setTimeout(() => inputChallengeFriend.focus(), 50);
}

/**
 * Evaluates friend challenge typing against enrolled profile.
 */
function handleFriendSubmit() {
  if (!activeCapture || !userProfile) return;

  const events = activeCapture.stop();
  activeCapture = null;

  const attempt = readAttempt(events);
  if ('message' in attempt) {
    showFeedback(friendFeedback, 'warn', attempt.message);
    prepareChallengeFriend(true);
    return;
  }

  // With phantoms on, this is where a stranger stops — they typed the passphrase they
  // were shown, and it is missing keystrokes they never saw.
  if (attempt.phantomMismatch) {
    showFeedback(
      friendFeedback,
      'warn',
      'Right passphrase, wrong keystrokes. Their attempt is missing your Phantom Keys — on the real server this never even reaches the rhythm check.',
    );
    // A wrong script never reaches scoring, so it does not consume an attempt.
    rhythmLightFriend.className = 'rhythm-light-dot fail';
    prepareChallengeFriend(true);
    return;
  }

  const s = score(userProfile, attempt.features);
  friendAttempts.push(s);
  const b = bandFor(s);
  debugNote(
    'friend',
    b === 'fail' ? 'rejected' : 'accepted',
    `attempt ${friendAttempts.length} scored ${s.toFixed(3)} → ${b}`,
  );

  rhythmLightFriend.className = `rhythm-light-dot ${b}`;
  recordFriendBest();

  // An attacker would not stop at one go, so neither does the demo.
  if (friendAttempts.length >= FRIEND_ATTEMPTS) {
    showFeedback(
      friendFeedback,
      'ok',
      `That was attempt ${FRIEND_ATTEMPTS} of ${FRIEND_ATTEMPTS}. Handing the keyboard back.`,
    );
    setTimeout(() => setState('challenge_you'), 900);
    return;
  }

  showFeedback(
    friendFeedback,
    b === 'pass' ? 'warn' : 'ok',
    `Attempt ${friendAttempts.length}: ${s.toFixed(2)} — ${b}. ${FRIEND_ATTEMPTS - friendAttempts.length} ${FRIEND_ATTEMPTS - friendAttempts.length === 1 ? 'try' : 'tries'} left, or hand the keyboard back.`,
  );
  renderFriendAttempts();
  prepareChallengeFriend(true);
}

/**
 * Prepares your challenge input and capture.
 */
function prepareChallengeYou(keepFeedback = false) {
  if (activeCapture) {
    activeCapture.cancel();
    activeCapture = null;
  }

  inputChallengeYou.value = '';
  youKeyCounter.textContent = `0 / ${targetPassphrase.length} keys`;
  if (!keepFeedback) {
    youFeedback.className = 'text-xs font-medium px-3 py-2 rounded-lg hidden';
    youFeedback.textContent = '';
  }
  rhythmLightYou.className = 'rhythm-light-dot listening';

  try {
    activeCapture = startCapture(inputChallengeYou, rhythmLightYou, {
      onPulse: () => {
        triggerPulse(rhythmLightYou, youMiniBars);
        youKeyCounter.textContent = `${inputChallengeYou.value.length} / ${targetPassphrase.length} keys`;
      },
    });
  } catch (err) {
    console.error('Failed to start you capture:', err);
  }

  setTimeout(() => inputChallengeYou.focus(), 50);
}

/**
 * Evaluates your challenge typing against your profile.
 */
function handleYouSubmit() {
  if (!activeCapture || !userProfile) return;

  const events = activeCapture.stop();
  activeCapture = null;

  const attempt = readAttempt(events);
  if ('message' in attempt) {
    showFeedback(youFeedback, 'warn', attempt.message);
    prepareChallengeYou(true);
    return;
  }
  if (attempt.phantomMismatch) {
    showFeedback(
      youFeedback,
      'warn',
      'That’s the passphrase, but not your script — the Phantom Keys were different. Try it again the way you enrolled it.',
    );
    prepareChallengeYou(true);
    return;
  }

  const s = score(userProfile, attempt.features);
  const b = bandFor(s);
  youScoreResult = { score: s, band: b };
  debugNote('you', b === 'fail' ? 'rejected' : 'accepted', `scored ${s.toFixed(3)} → ${b}`);

  rhythmLightYou.className = `rhythm-light-dot ${b}`;
  setTimeout(() => setState('results'), 500);
}

/**
 * Renders the side-by-side comparison in the results section.
 */
/** The friend's best attempt is what matters: an attacker keeps whichever worked. */
function recordFriendBest() {
  if (friendAttempts.length === 0) {
    friendScoreResult = null;
    friendAttempts = [];
    return;
  }
  const best = Math.max(...friendAttempts);
  friendScoreResult = { score: best, band: bandFor(best) };
}

function renderFriendAttempts() {
  friendAttemptCounter.textContent = `Attempt ${Math.min(friendAttempts.length + 1, FRIEND_ATTEMPTS)} of ${FRIEND_ATTEMPTS}`;
  friendAttemptHistory.textContent = friendAttempts.length
    ? friendAttempts.map((v, i) => `#${i + 1} ${v.toFixed(2)}`).join('   ')
    : '';
}

/** Paints the segmented control and the sentence under it. */
function renderStrictness() {
  const { pass, grey } = rhythmBands(strictness);
  const hint = `Passes at ${pass.toFixed(2)} and above · grey from ${grey.toFixed(2)} · below that it fails.`;
  for (const el of [strictnessHintYou, strictnessHintResults]) el.textContent = hint;
  for (const button of Array.from(document.querySelectorAll('.strictness-option'))) {
    const value = (button as HTMLElement).dataset.strictness;
    (button as HTMLElement).setAttribute('aria-pressed', String(value === strictness));
  }
}

function renderResults() {
  if (!friendScoreResult || !youScoreResult) return;

  const { pass } = rhythmBands(strictness);

  // Every attempt, so a single lucky try is visible rather than hidden behind a best.
  friendAttemptList.innerHTML = '';
  if (friendAttempts.length > 0) {
    const heading = document.createElement('div');
    heading.className = 'font-semibold text-slate-700';
    heading.textContent = `Friend's attempts (best counts, as it would for an attacker):`;
    friendAttemptList.appendChild(heading);
    for (const [i, value] of friendAttempts.entries()) {
      const row = document.createElement('div');
      const b = bandFor(value);
      row.className = b === 'pass' ? 'text-rose-700' : 'text-slate-600';
      row.textContent = `  #${i + 1}  ${value.toFixed(2)}  ${b}`;
      friendAttemptList.appendChild(row);
    }
  }

  const fScore = friendScoreResult.score;
  const fBand = friendScoreResult.band;
  friendScoreDisplay.textContent = fScore.toFixed(2);

  // The badge, the sentence and the outcome line all come from the same band, so the
  // card cannot say PASS and "neutralized" at once — which is exactly what it did.
  const badge = (el: HTMLElement, text: string, tone: 'good' | 'warn' | 'bad') => {
    el.textContent = text;
    const palette = {
      good: 'bg-teal-100 text-teal-800 border-teal-300',
      warn: 'bg-amber-100 text-amber-800 border-amber-300',
      bad: 'bg-rose-200/80 text-rose-800 border-rose-300',
    }[tone];
    el.className = `px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide border ${palette}`;
  };

  if (fBand === 'pass') {
    // Do not dress this up. They got in, and the honest lesson is the lever above.
    badge(friendBandBadge, 'PASS', 'bad');
    friendScoreDisplay.className = 'text-5xl font-extrabold text-rose-600 font-mono';
    friendExplanation.textContent = `They cleared ${pass.toFixed(2)} on this setting, so at Strictness "${strictness}" this attempt would have opened the vault. Close cadences do happen — try Strict above and watch the same attempt re-judged, or add a Phantom Key they never saw.`;
    friendOutcome.textContent = 'Outcome: passphrase alone was enough — raise Strictness';
    friendOutcome.className =
      'mt-5 pt-4 border-t border-rose-200 text-[11px] font-mono font-semibold text-rose-800';
  } else if (fBand === 'grey') {
    badge(friendBandBadge, 'GREY', 'warn');
    friendScoreDisplay.className = 'text-5xl font-extrabold text-amber-600 font-mono';
    friendExplanation.textContent =
      'Close, but not close enough to pass on its own. A real login would stop here and demand a second factor before releasing anything.';
    friendOutcome.textContent = 'Outcome: step-up required — no keys released';
    friendOutcome.className =
      'mt-5 pt-4 border-t border-amber-200 text-[11px] font-mono font-semibold text-amber-800';
  } else {
    badge(friendBandBadge, 'FAIL', 'bad');
    friendScoreDisplay.className = 'text-5xl font-extrabold text-rose-600 font-mono';
    friendExplanation.textContent =
      'Their rhythm diverged from your baseline. The server refuses to release its share of the vault key, so the passphrase on its own bought nothing.';
    friendOutcome.textContent = 'Outcome: stolen password neutralized';
    friendOutcome.className =
      'mt-5 pt-4 border-t border-rose-200 text-[11px] font-mono font-semibold text-rose-800';
  }

  const yScore = youScoreResult.score;
  const yBand = youScoreResult.band;
  youScoreDisplay.textContent = yScore.toFixed(2);

  if (yBand === 'pass') {
    badge(youBandBadge, 'PASS', 'good');
    youScoreDisplay.className = 'text-5xl font-extrabold text-teal-700 font-mono';
    youExplanation.textContent =
      'Your rhythm matched the profile you enrolled. The vault key is released with nothing extra to carry and nothing extra to type.';
    youOutcome.textContent = 'Outcome: vault unlocked seamlessly';
    youOutcome.className =
      'mt-5 pt-4 border-t border-teal-200 text-[11px] font-mono font-semibold text-teal-800';
  } else if (yBand === 'grey') {
    badge(youBandBadge, 'GREY', 'warn');
    youScoreDisplay.className = 'text-5xl font-extrabold text-amber-600 font-mono';
    youExplanation.textContent =
      'Your own rhythm read as slightly off today — a different chair, a different keyboard, a different hour. You are asked to confirm rather than turned away, and those samples then teach the profile.';
    youOutcome.textContent = 'Outcome: step-up, then in';
    youOutcome.className =
      'mt-5 pt-4 border-t border-amber-200 text-[11px] font-mono font-semibold text-amber-800';
  } else {
    badge(youBandBadge, 'FAIL', 'bad');
    youScoreDisplay.className = 'text-5xl font-extrabold text-rose-600 font-mono';
    youExplanation.textContent = `That did not match your baseline at Strictness "${strictness}". Nobody is locked out by their own hands: a step-up factor gets you in, and Relaxed above re-judges this same attempt.`;
    youOutcome.textContent = 'Outcome: step-up required';
    youOutcome.className =
      'mt-5 pt-4 border-t border-rose-200 text-[11px] font-mono font-semibold text-rose-800';
  }
}

/**
 * Stops a button from stealing focus when it is clicked.
 *
 * A-14.1 voids any sample whose field loses focus — that is how "the key did not move
 * focus" is enforced without a per-platform key list, and it must stay. But clicking a
 * submit button blurs the field before the click handler ever runs, so every
 * click-submitted sample was being discarded as `focus_lost`. Preventing the default
 * on mousedown stops the focus shift entirely, so the rule keeps its teeth and the
 * button still works — including via the keyboard, which never blurs anyway.
 */
function keepFocusOnMouseDown(button: HTMLButtonElement) {
  button.addEventListener('mousedown', (event) => event.preventDefault());
}

// Event Listeners Setup
function initEventListeners() {
  for (const button of [btnSubmitEnrollSample, btnSubmitFriendChallenge, btnSubmitYouChallenge]) {
    keepFocusOnMouseDown(button);
  }

  if (DEBUG) debugPanel.classList.remove('hidden');

  // Two setup choices, one selected at a time. The selected one is the only thing
  // "Begin enrollment" reads, so there is never a question of which phrase is in play.
  const shuffle = () => {
    const chosen = SAMPLE_PHRASES[Math.floor(Math.random() * SAMPLE_PHRASES.length)];
    randomPhraseDisplay.textContent = chosen ?? '';
  };
  const selectChoice = (choice: 'random' | 'own') => {
    setupChoice = choice;
    optionRandom.setAttribute('aria-pressed', String(choice === 'random'));
    optionOwn.setAttribute('aria-pressed', String(choice === 'own'));
    setupError.classList.add('hidden');
    if (choice === 'own') inputPassphraseSetup.focus();
  };

  shuffle();
  selectChoice('random');

  optionRandom.addEventListener('click', () => selectChoice('random'));
  optionOwn.addEventListener('click', () => selectChoice('own'));
  // Typing in the field is itself a choice; nobody should have to click the card first.
  inputPassphraseSetup.addEventListener('focus', () => selectChoice('own'));
  inputPassphraseSetup.addEventListener('input', () => selectChoice('own'));

  btnSamplePhrase.addEventListener('click', (event) => {
    event.stopPropagation();
    shuffle();
    selectChoice('random');
  });

  // Begin enrollment button
  btnBeginEnroll.addEventListener('click', () => {
    const phrase =
      setupChoice === 'random'
        ? (randomPhraseDisplay.textContent ?? '').trim()
        : inputPassphraseSetup.value.trim();
    if (phrase.length < 10) {
      setupError.textContent =
        setupChoice === 'own'
          ? 'Your passphrase needs at least 10 characters for a readable rhythm.'
          : 'Pick a phrase first.';
      setupError.classList.remove('hidden');
      return;
    }
    setupError.classList.add('hidden');
    targetPassphrase = phrase;
    inputPassphraseSetup.value = phrase;
    enrollmentSamples = [];
    canonicalScript = null;
    userProfile = null;
    friendScoreResult = null;
    friendAttempts = [];
    youScoreResult = null;
    setState('enrolling');
  });

  // Enroll input Enter key
  inputEnroll.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleEnrollSampleSubmit();
    }
  });
  btnSubmitEnrollSample.addEventListener('click', handleEnrollSampleSubmit);

  // Profile built -> Challenge button
  btnGotoChallenge.addEventListener('click', () => {
    setState('challenge_friend');
  });

  // Friend input Enter key
  inputChallengeFriend.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleFriendSubmit();
    }
  });
  btnSubmitFriendChallenge.addEventListener('click', handleFriendSubmit);

  // You input Enter key
  inputChallengeYou.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleYouSubmit();
    }
  });
  btnSubmitYouChallenge.addEventListener('click', handleYouSubmit);

  // Retest action buttons
  // A fresh friend starts a fresh set of attempts; the previous person's best is
  // discarded rather than quietly carried forward as if it were theirs.
  btnTestAnotherFriend.addEventListener('click', () => {
    friendAttempts = [];
    friendScoreResult = null;
    friendAttempts = [];
    setState('challenge_friend');
  });

  btnFriendGiveUp.addEventListener('click', () => {
    recordFriendBest();
    setState('challenge_you');
  });

  for (const button of Array.from(document.querySelectorAll('.strictness-option'))) {
    button.addEventListener('click', () => {
      const value = (button as HTMLElement).dataset.strictness;
      if (value !== 'strict' && value !== 'medium' && value !== 'relaxed') return;
      strictness = value;
      // Re-judge what was already recorded; nobody has to type again.
      recordFriendBest();
      if (youScoreResult !== null) youScoreResult.band = bandFor(youScoreResult.score);
      renderStrictness();
      if (currentState === 'results') renderResults();
    });
  }
  btnRetestYou.addEventListener('click', () => setState('challenge_you'));
  btnNewPassphrase.addEventListener('click', () => setState('idle'));

  // Global Reset button
  btnReset.addEventListener('click', () => {
    enrollmentSamples = [];
    canonicalScript = null;
    userProfile = null;
    friendScoreResult = null;
    friendAttempts = [];
    youScoreResult = null;
    setState('idle');
  });

  // Email form
  emailForm.addEventListener('submit', (e) => {
    e.preventDefault();
    emailConfirmation.classList.remove('hidden');
    emailForm.reset();
  });
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  initEventListeners();
  setState('idle');
});
