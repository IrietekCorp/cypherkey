import './styles.css';

import { startCapture } from '../core/biometrics/capture';
import { extractFeatures } from '../core/biometrics/features';
import { band, buildProfile, score } from '../core/biometrics/score';
import type { Profile } from '../core/biometrics/score';
import type { FeatureVector, KeyEvent } from '../core/biometrics/types';

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
const btnRetestFriend = document.getElementById('btn-retest-friend') as HTMLButtonElement;
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
      prepareChallengeFriend();
      break;

    case 'challenge_you':
      stepChallengeYou.classList.remove('hidden');
      prepareChallengeYou();
      break;

    case 'results':
      stepResults.classList.remove('hidden');
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
function prepareEnrollSample() {
  if (activeCapture) {
    activeCapture.cancel();
    activeCapture = null;
  }

  inputEnroll.value = '';
  enrollKeyCounter.textContent = `0 / ${targetPassphrase.length} keys`;
  enrollFeedback.className = 'text-xs font-medium px-3 py-2 rounded-lg hidden';
  enrollFeedback.textContent = '';
  enrollCurrentStep.textContent = String(enrollmentSamples.length + 1);

  rhythmLight.className = 'rhythm-light-dot listening';

  try {
    activeCapture = startCapture(inputEnroll, rhythmLight, {
      onPulse: () => {
        triggerPulse(rhythmLight, rhythmMiniBars);
        enrollKeyCounter.textContent = `${inputEnroll.value.length} / ${targetPassphrase.length} keys`;
      },
    });
  } catch (err) {
    console.error('Failed to start capture:', err);
  }

  setTimeout(() => inputEnroll.focus(), 50);
}

/**
 * Handles submission of one enrollment sample.
 */
function handleEnrollSampleSubmit() {
  if (!activeCapture) return;

  const typed = inputEnroll.value;
  const rawEvents = activeCapture.stop();
  activeCapture = null;

  // Filter out control keys the M0 demo never scored. M1-18 replaces this with the
  // A-14.1 token rules, where Escape is a Phantom Key rather than something to drop.
  const events = rawEvents.filter(
    (e) => e.type !== 'blur' && e.key !== 'Enter' && e.key !== 'Tab' && e.key !== 'Escape',
  );

  if (typed !== targetPassphrase) {
    enrollFeedback.className =
      'text-xs font-medium px-3 py-2 rounded-lg bg-amber-50 text-amber-800 border border-amber-200';
    enrollFeedback.textContent =
      'Passphrase characters do not match target. Please type the exact phrase.';
    enrollFeedback.classList.remove('hidden');
    prepareEnrollSample();
    return;
  }

  const result = extractFeatures(events, targetPassphrase.length);

  if ('error' in result) {
    enrollFeedback.className =
      'text-xs font-medium px-3 py-2 rounded-lg bg-amber-50 text-amber-800 border border-amber-200';
    if (result.error === 'length_mismatch') {
      enrollFeedback.textContent = 'Length mismatch. Please type the full phrase smoothly.';
    } else {
      enrollFeedback.textContent = 'Typing pattern interrupted. Please try again.';
    }
    enrollFeedback.classList.remove('hidden');
    prepareEnrollSample();
    return;
  }

  enrollmentSamples.push(result);
  renderEnrollDots();

  // Bloom animation
  rhythmLight.className = 'rhythm-light-dot pass';

  if (enrollmentSamples.length >= 8) {
    userProfile = buildProfile(enrollmentSamples);
    setTimeout(() => setState('built'), 400);
  } else {
    enrollFeedback.className =
      'text-xs font-medium px-3 py-2 rounded-lg bg-teal-50 text-teal-800 border border-teal-200';
    enrollFeedback.textContent = `✓ Sample ${enrollmentSamples.length} recorded! Next sample...`;
    enrollFeedback.classList.remove('hidden');
    setTimeout(() => prepareEnrollSample(), 350);
  }
}

/**
 * Prepares the friend challenge input and capture.
 */
function prepareChallengeFriend() {
  if (activeCapture) {
    activeCapture.cancel();
    activeCapture = null;
  }

  inputChallengeFriend.value = '';
  friendKeyCounter.textContent = `0 / ${targetPassphrase.length} keys`;
  friendFeedback.className = 'text-xs font-medium px-3 py-2 rounded-lg hidden';
  friendFeedback.textContent = '';
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

  const typed = inputChallengeFriend.value;
  const rawEvents = activeCapture.stop();
  activeCapture = null;

  const events = rawEvents.filter(
    (e) => e.type !== 'blur' && e.key !== 'Enter' && e.key !== 'Tab' && e.key !== 'Escape',
  );

  if (typed !== targetPassphrase) {
    friendFeedback.className =
      'text-xs font-medium px-3 py-2 rounded-lg bg-amber-50 text-amber-800 border border-amber-200';
    friendFeedback.textContent = 'Friend must type the exact target passphrase for evaluation.';
    friendFeedback.classList.remove('hidden');
    prepareChallengeFriend();
    return;
  }

  const result = extractFeatures(events, targetPassphrase.length);
  if ('error' in result) {
    friendFeedback.className =
      'text-xs font-medium px-3 py-2 rounded-lg bg-amber-50 text-amber-800 border border-amber-200';
    friendFeedback.textContent =
      'Sample discarded (e.g. backspace/malformed). Please type once more.';
    friendFeedback.classList.remove('hidden');
    prepareChallengeFriend();
    return;
  }

  const s = score(userProfile, result);
  const b = band(s);
  friendScoreResult = { score: s, band: b };

  // Show color reaction on dot
  rhythmLightFriend.className = `rhythm-light-dot ${b}`;

  setTimeout(() => setState('challenge_you'), 500);
}

/**
 * Prepares your challenge input and capture.
 */
function prepareChallengeYou() {
  if (activeCapture) {
    activeCapture.cancel();
    activeCapture = null;
  }

  inputChallengeYou.value = '';
  youKeyCounter.textContent = `0 / ${targetPassphrase.length} keys`;
  youFeedback.className = 'text-xs font-medium px-3 py-2 rounded-lg hidden';
  youFeedback.textContent = '';
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

  const typed = inputChallengeYou.value;
  const rawEvents = activeCapture.stop();
  activeCapture = null;

  const events = rawEvents.filter(
    (e) => e.type !== 'blur' && e.key !== 'Enter' && e.key !== 'Tab' && e.key !== 'Escape',
  );

  if (typed !== targetPassphrase) {
    youFeedback.className =
      'text-xs font-medium px-3 py-2 rounded-lg bg-amber-50 text-amber-800 border border-amber-200';
    youFeedback.textContent = 'Please type the exact target passphrase.';
    youFeedback.classList.remove('hidden');
    prepareChallengeYou();
    return;
  }

  const result = extractFeatures(events, targetPassphrase.length);
  if ('error' in result) {
    youFeedback.className =
      'text-xs font-medium px-3 py-2 rounded-lg bg-amber-50 text-amber-800 border border-amber-200';
    youFeedback.textContent = 'Sample discarded (e.g. backspace/malformed). Please type once more.';
    youFeedback.classList.remove('hidden');
    prepareChallengeYou();
    return;
  }

  const s = score(userProfile, result);
  const b = band(s);
  youScoreResult = { score: s, band: b };

  rhythmLightYou.className = `rhythm-light-dot ${b}`;

  setTimeout(() => setState('results'), 500);
}

/**
 * Renders the side-by-side comparison in the results section.
 */
function renderResults() {
  if (!friendScoreResult || !youScoreResult) return;

  // Render Friend Card
  const fScore = friendScoreResult.score;
  const fBand = friendScoreResult.band;
  friendScoreDisplay.textContent = fScore.toFixed(2);

  if (fBand === 'pass') {
    friendBandBadge.textContent = 'PASS';
    friendBandBadge.className =
      'px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide bg-teal-100 text-teal-800 border border-teal-300';
    friendScoreDisplay.className = 'text-5xl font-extrabold text-teal-700 font-mono';
    friendExplanation.textContent =
      'Rhythm showed high similarity. In edge cases with close cadences, step-up factors guarantee defense.';
  } else if (fBand === 'grey') {
    friendBandBadge.textContent = 'GREY';
    friendBandBadge.className =
      'px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide bg-amber-100 text-amber-800 border border-amber-300';
    friendScoreDisplay.className = 'text-5xl font-extrabold text-amber-600 font-mono';
    friendExplanation.textContent =
      'Rhythm fell in the grey threshold (0.45 - 0.62). Server demands step-up verification before releasing keys.';
  } else {
    friendBandBadge.textContent = 'FAIL';
    friendBandBadge.className =
      'px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide bg-rose-200/80 text-rose-800 border border-rose-300';
    friendScoreDisplay.className = 'text-5xl font-extrabold text-rose-600 font-mono';
    friendExplanation.textContent =
      'Rhythm significantly diverged from your baseline profile. Server refuses to release the secret share; vault remains locked.';
  }

  // Render You Card
  const yScore = youScoreResult.score;
  const yBand = youScoreResult.band;
  youScoreDisplay.textContent = yScore.toFixed(2);

  if (yBand === 'pass') {
    youBandBadge.textContent = 'PASS';
    youBandBadge.className =
      'px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide bg-teal-200/80 text-teal-800 border border-teal-300';
    youScoreDisplay.className = 'text-5xl font-extrabold text-teal-700 font-mono';
    youExplanation.textContent =
      'Rhythm verified seamlessly against your profile. Vault key unwrapped instantly with zero extra steps or dongles.';
  } else if (yBand === 'grey') {
    youBandBadge.textContent = 'GREY';
    youBandBadge.className =
      'px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide bg-amber-100 text-amber-800 border border-amber-300';
    youScoreDisplay.className = 'text-5xl font-extrabold text-amber-600 font-mono';
    youExplanation.textContent =
      'Your rhythm looks slightly different today (speed or posture variance). Step-up fallback allows graceful entry.';
  } else {
    youBandBadge.textContent = 'FAIL';
    youBandBadge.className =
      'px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide bg-rose-200/80 text-rose-800 border border-rose-300';
    youScoreDisplay.className = 'text-5xl font-extrabold text-rose-600 font-mono';
    youExplanation.textContent =
      'Rhythm did not match baseline. Our graceful degradation ladder offers passkey fallback so you are never locked out.';
  }
}

// Event Listeners Setup
function initEventListeners() {
  // Random sample phrase button
  btnSamplePhrase.addEventListener('click', () => {
    const randomIndex = Math.floor(Math.random() * SAMPLE_PHRASES.length);
    const chosen = SAMPLE_PHRASES[randomIndex];
    if (chosen) {
      inputPassphraseSetup.value = chosen;
    }
  });

  // Begin enrollment button
  btnBeginEnroll.addEventListener('click', () => {
    const phrase = inputPassphraseSetup.value.trim();
    if (phrase.length < 10) {
      setupError.textContent =
        'Passphrase must be at least 10 characters for reliable rhythm extraction.';
      setupError.classList.remove('hidden');
      return;
    }
    setupError.classList.add('hidden');
    targetPassphrase = phrase;
    enrollmentSamples = [];
    userProfile = null;
    friendScoreResult = null;
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
  btnRetestFriend.addEventListener('click', () => setState('challenge_friend'));
  btnRetestYou.addEventListener('click', () => setState('challenge_you'));
  btnNewPassphrase.addEventListener('click', () => setState('idle'));

  // Global Reset button
  btnReset.addEventListener('click', () => {
    enrollmentSamples = [];
    userProfile = null;
    friendScoreResult = null;
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
