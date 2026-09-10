import { startCapture } from '../core/biometrics/capture';
import { extractFeatures, getFeatureRanges } from '../core/biometrics/features';
import { type Profile, band, buildProfile, score } from '../core/biometrics/score';
import {
  eventsToScript,
  readableToken,
  scriptLength,
  scriptsEqual,
} from '../core/biometrics/script';
import type { FeatureVector, KeyEvent } from '../core/biometrics/types';
import { type Strictness, rhythmBands } from '../core/crypto/phantom';
import { initTheme } from './theme';

/**
 * The Rhythm Trial.
 *
 * The whole page is one claim -- that how you type is a factor -- and the only honest way
 * to make it is to let a stranger try. So this is a game with a losing condition for the
 * visitor's friend, and everything it says has to be true of the shipped product or the
 * demonstration is a magic trick.
 *
 * Which is why it imports `core/biometrics` rather than reimplementing it. The tokenizer,
 * the 3n+5 feature vector, the σ floor, the weights and the bands are the same code the
 * extension unlocks with. A demo with its own scoring maths would drift, and the first
 * person to notice would be someone deciding whether to trust the product.
 *
 * Nothing here is sent anywhere. There is no `fetch` in this module and none in what it
 * imports, which is what makes `network requests 0` on the rail a fact rather than a
 * promise.
 */

initTheme();

/* ---- constants ---------------------------------------------------------- */

const SAMPLES_REQUIRED = 8;
const MIN_PHRASE = 10;
const INTRUDER_ATTEMPTS = 3;

/** Four-word phrases out of this bank give distinct dwell and flight intervals. */
const WORDS =
  'quiet river carries stone amber lantern folds north copper meadow drifts signal velvet harbor counts ember silent orbit holds cedar paper tide opens window'.split(
    ' ',
  );

const TEACH_TITLES: Record<number, string> = {
  1: 'Type it the way you normally would.',
  2: 'Again. Consistency beats speed.',
  5: 'Keep the same Phantom Keys, if any.',
  8: 'Last one. Same rhythm.',
};

type Phase = 'calibrate' | 'teach' | 'forged' | 'intruder' | 'you' | 'verdict';

type Attempt = {
  vector: FeatureVector;
  tokens: number;
  totalMs: number;
  meanDwell: number;
  meanFlight: number;
  /** A script that does not match the enrolled one is refused before it is scored. */
  scriptMatched: boolean;
};

/* ---- state -------------------------------------------------------------- */

let phase: Phase = 'calibrate';
let phrase = '';
let usingOwnPhrase = false;
let canonicalScript: string | null = null;
let samples: FeatureVector[] = [];
let profile: Profile | null = null;
let level = 1;
let streak = 0;
let resets = 0;
let phantomEverySample = true;
let consistency: number | null = null;

let intruderAttempts: Attempt[] = [];
let intruderTriesUsed = 0;
let yourAttempt: Attempt | null = null;
let yourFirstTry = true;
let strictness: Strictness = 'medium';

const unlocked = new Set<string>();

/* ---- element helpers ---------------------------------------------------- */

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [
  ...root.querySelectorAll<T>(sel),
];

const stagePane = $('.ck-stage-pane') as HTMLElement;
const light = $('[data-light]') as HTMLElement;
const lightLabel = $('[data-light-label]') as HTMLElement;
const logList = $('[data-log]') as HTMLElement;

const stageOf = (name: Phase) => $(`[data-stage="${name}"]`) as HTMLElement;

/* ---- the light ----------------------------------------------------------- */

type LightState = 'idle' | 'ready' | 'recording' | 'captured' | 'matched' | 'amber' | 'refused';

const LIGHT_LABEL: Record<LightState, string> = {
  idle: 'Idle',
  ready: 'Ready',
  recording: 'Listening',
  captured: 'Captured',
  matched: 'Matched',
  amber: 'Amber',
  refused: 'Refused',
};

function setLight(state: LightState, detail?: string): void {
  light.dataset.state = state;
  lightLabel.textContent = detail ?? LIGHT_LABEL[state];
}

/* ---- the rail ------------------------------------------------------------ */

function rail(key: string, value: string): void {
  const cell = $(`[data-m="${key}"]`);
  if (cell !== null) cell.textContent = value;
}

type LogTone = 'text' | 'green' | 'amber' | 'fail' | 'train';

/**
 * Newest first, nine lines. Longer than that and it stops being glanceable.
 *
 * `slot` is the enrolment sample number, 1..8, and it picks the hue. Teaching used to be
 * eight identical green lines under eight identical green cells, which reads as one event
 * repeated rather than eight distinct samples accumulating into a profile. Amber and red
 * keep their meanings and are never in the training ramp.
 */
function log(line: string, tone: LogTone = 'text', slot?: number): void {
  const item = document.createElement('li');
  item.textContent = line;
  item.dataset.tone = tone;
  if (slot !== undefined) item.dataset.slot = String(slot);
  logList.prepend(item);
  while (logList.children.length > 9) logList.lastElementChild?.remove();
}

/* ---- maths --------------------------------------------------------------- */

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * The one number this page is willing to show.
 *
 * It is a property of *your* typing -- how repeatable it is -- and reveals nothing about
 * how close any particular attempt came. The match score stays hidden here for exactly
 * the reason it stays hidden in the product: it is the only signal an attacker could
 * iterate against, and it tells an honest user nothing they can act on.
 */
function consistencyOf(built: Profile): number {
  const ranges = getFeatureRanges(built.len);
  const ratios: number[] = [];
  for (let i = ranges.dwell[0]; i < ranges.flight[1]; i += 1) {
    const mu = built.means[i] ?? 0;
    const sigma = built.stds[i] ?? 0;
    if (mu > 0) ratios.push(sigma / mu);
  }
  return Math.max(0, Math.min(100, Math.round(100 - 100 * mean(ratios))));
}

/**
 * A millisecond figure, coarsened before it is shown to anybody.
 *
 * The rail reads out of *your* typing, and printing it to the millisecond publishes the
 * resolution the product works at alongside a worked example of one person's timings.
 * That is the raw material of a forgery and it is worth nothing to the visitor, who is
 * here for a verdict rather than a stopwatch.
 *
 * So the display is quantised to a 10 ms bucket and prefixed `≈`, which is the honest
 * label for what it now is. **Scoring never sees this.** `score()` runs on the vector
 * core produced; this function exists on the way to `textContent` and nowhere else.
 */
function blurMs(ms: number): string {
  return `≈${Math.round(ms / 10) * 10} ms`;
}

/**
 * Says what actually differed between the enrolled script and this sample.
 *
 * This message used to read "a Backspace that was not there before, or one that was",
 * which guesses — and guesses wrong. A **lone modifier tap** is a token too (A-14.1), it
 * leaves no character behind, and the resolved text is identical either way, so the
 * sample sails past the "is this the phrase" check and fails the script comparison for a
 * reason the visitor cannot see and would never think of. Naming Backspace when the real
 * difference was a stray Shift tap sends someone hunting for the wrong thing.
 *
 * Diagnostics of this kind belong in the trial and nowhere else (AGENTS.md): the phrase
 * is a throwaway the visitor invented, there is no account, nothing is stored and nothing
 * is sent. **Never build the equivalent in the extension.**
 */
function describeScriptDelta(canonical: string, got: string): string {
  const a = [...canonical];
  const b = [...got];
  const limit = Math.min(a.length, b.length);

  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;

  // The resolved text already matched, so whatever differs here is a Phantom Key.
  if (b.length > a.length) return `an extra ${readableToken(b[i] ?? '')} at keystroke ${i + 1}`;
  if (b.length < a.length) return `no ${readableToken(a[i] ?? '')} at keystroke ${i + 1}`;
  if (i < limit) {
    return `${readableToken(a[i] ?? '')} became ${readableToken(b[i] ?? '')} at keystroke ${i + 1}`;
  }
  return 'a different key sequence';
}

function summarise(vector: FeatureVector): { dwell: number; flight: number; total: number } {
  const ranges = getFeatureRanges(vector.len);
  const dwell = vector.values.slice(ranges.dwell[0], ranges.dwell[1]);
  const flight = vector.values.slice(ranges.flight[0], ranges.flight[1]);
  return {
    dwell: Math.round(mean(dwell)),
    flight: Math.round(mean(flight)),
    total: Math.round(vector.values[ranges.globals[0]] ?? 0),
  };
}

/* ---- live waveform -------------------------------------------------------- */

/**
 * A mirror of the sample, drawn from listeners of its own.
 *
 * `startCapture` does not hand back events until it stops, and it should not -- a
 * half-finished sample is not a sample. So the drawing keeps its own timings purely to
 * paint with. Nothing measured here is ever scored; the vector always comes from core.
 */
type LiveKey = { downT: number; upT: number | null };

let liveKeys: LiveKey[] = [];

function paintWaveform(container: HTMLElement, keys: LiveKey[], envelope?: Profile | null): void {
  const bars = $('[data-waveform-bars]', container);
  if (bars === null) return;
  bars.replaceChildren();

  const ranges = envelope == null ? null : getFeatureRanges(envelope.len);

  keys.forEach((key, i) => {
    const dwell = (key.upT ?? key.downT) - key.downT;
    const previous = keys[i - 1];
    const flight = previous?.upT == null ? 0 : key.downT - previous.upT;

    const bar = document.createElement('span');
    bar.style.height = `${Math.min(100, dwell / 2.4)}%`;
    bar.style.marginLeft = `${Math.min(40, flight / 8)}px`;

    // Against a built envelope, a bar more than 2σ from the mean is drawn as a miss.
    // This is a picture of the comparison, not the comparison: the verdict comes from
    // `score()` over the whole vector.
    if (envelope != null && ranges != null && i < envelope.len) {
      const mu = envelope.means[ranges.dwell[0] + i] ?? 0;
      const sigma = envelope.stds[ranges.dwell[0] + i] ?? 1;
      if (Math.abs(dwell - mu) / sigma > 2) bar.dataset.outside = 'true';
    }
    bars.append(bar);
  });
}

/* ---- capture -------------------------------------------------------------- */

let handle: ReturnType<typeof startCapture> | null = null;
let detachLive: (() => void) | null = null;

function armCapture(): void {
  const stage = stageOf(phase);
  const input = $<HTMLInputElement>('[data-type-input]', stage);
  const waveform = $('[data-waveform]', stage);
  if (input === null) return;

  disarmCapture();
  liveKeys = [];
  if (waveform !== null) paintWaveform(waveform, liveKeys);
  updateKeyCount();

  try {
    handle = startCapture(input, light, {
      onPulse: () => setLight('recording'),
    });
  } catch {
    // The only throw is RhythmLightNotVisible, and it is a refusal rather than a fault.
    setLight('idle', 'Light hidden');
    return;
  }
  setLight('ready');

  const down = (event: KeyboardEvent) => {
    if (event.key.length !== 1 && event.key !== 'Backspace') return;
    liveKeys.push({ downT: performance.now(), upT: null });
    updateKeyCount();
    if (waveform !== null) paintWaveform(waveform, liveKeys, phase === 'intruder' ? profile : null);
  };
  const up = () => {
    for (let i = liveKeys.length - 1; i >= 0; i -= 1) {
      const key = liveKeys[i];
      if (key !== undefined && key.upT === null) {
        key.upT = performance.now();
        break;
      }
    }
    if (waveform !== null) paintWaveform(waveform, liveKeys, phase === 'intruder' ? profile : null);
  };
  input.addEventListener('keydown', down);
  input.addEventListener('keyup', up);
  detachLive = () => {
    input.removeEventListener('keydown', down);
    input.removeEventListener('keyup', up);
  };
}

function disarmCapture(): void {
  handle?.cancel();
  handle = null;
  detachLive?.();
  detachLive = null;
}

function updateKeyCount(): void {
  const target = canonicalScript === null ? scriptLength(phrase) : scriptLength(canonicalScript);
  const keys = $('[data-hud-keys]');
  if (keys !== null) keys.textContent = `${liveKeys.length} / ${target}`;
  const progress = $('[data-type-progress]', stageOf(phase));
  if (progress !== null) {
    progress.style.width = `${Math.min(100, (liveKeys.length / Math.max(1, target)) * 100)}%`;
  }
}

/**
 * Throws the current sample away and starts it again, cleanly.
 *
 * **Escape is the reset here, and that is a deliberate divergence from the product.**
 * In the extension an Escape tap is a legitimate Phantom Key (A-14.1) — a keystroke that
 * leaves no character behind and becomes part of the secret. The trial gives it up
 * because a refused sample used to leave the typed text sitting in the box, looking like
 * progress that no longer existed, and the fix a keyboard reaches for is Escape.
 *
 * Backspace still carries the Phantom Keys demonstration, which is the more legible half
 * of it anyway: a character that appears and is deleted is visible in a way a lone
 * Escape never was.
 *
 * The recorded sample does not need protecting from this. `armCapture` cancels the
 * handle, so whatever core had buffered — the Escape included — is discarded rather than
 * scored.
 */
function resetSample(reason: 'escape' | 'refused'): void {
  const stage = stageOf(phase);
  const input = $<HTMLInputElement>('[data-type-input]', stage);
  if (input === null) return;

  input.value = '';
  if (reason === 'escape') {
    const feedback = $('[data-feedback]', stage);
    if (feedback !== null) feedback.textContent = '';
    log('sample cleared');
  }
  armCapture();
  // Focus last: `armCapture` arms on the element, and typing should be able to resume
  // without reaching for the mouse.
  input.focus();
}

/**
 * Ends the sample and turns it into a feature vector, or says why it could not.
 *
 * Every refusal here is a real one that the product also makes: a sample whose script
 * differs from the enrolled one is not a worse attempt, it is a different secret.
 */
function takeSample(): { vector: FeatureVector; events: KeyEvent[]; script: string } | string {
  if (handle === null) return 'Click into the box and type the phrase first.';
  const events = handle.stop();
  handle = null;
  detachLive?.();
  detachLive = null;

  const script = eventsToScript(events);
  if ('error' in script) return 'That attempt could not be measured. Type it again.';
  if (script.resolved !== phrase) return 'That is not the phrase. Type it exactly as shown.';

  const tokens = scriptLength(script.script);
  const vector = extractFeatures(events, tokens);
  if ('error' in vector) return 'That attempt could not be measured. Type it again.';

  return { vector, events, script: script.script };
}

/* ---- phases ---------------------------------------------------------------- */

function show(next: Phase): void {
  disarmCapture();
  phase = next;
  for (const name of ['calibrate', 'teach', 'forged', 'intruder', 'you', 'verdict'] as Phase[]) {
    stageOf(name).hidden = name !== next;
  }

  const hudStage = $('[data-hud-stage]');
  if (hudStage !== null) {
    hudStage.textContent = {
      calibrate: 'Calibrate',
      teach: `Teach ${level}/8`,
      forged: 'Forged',
      intruder: 'Intruder',
      you: 'Your turn',
      verdict: 'Verdict',
    }[next];
  }

  for (const chip of $$('[data-phrase-chip]')) chip.textContent = phrase;

  if (next === 'teach' || next === 'intruder' || next === 'you') {
    const input = $<HTMLInputElement>('[data-type-input]', stageOf(next));
    if (input !== null) {
      input.value = '';
      input.focus();
    }
    armCapture();
  } else {
    setLight('idle');
  }
  stagePane.scrollIntoView({ block: 'nearest' });
}

function renderStreak(): void {
  const strip = $('[data-hud-streak]');
  if (strip === null) return;
  strip.replaceChildren();
  for (let i = 0; i < SAMPLES_REQUIRED; i += 1) {
    const cell = document.createElement('span');
    // Accepted-but-reset reads as a dimmer green rather than as empty: the sample is
    // still in the profile, it just did not extend the run.
    cell.dataset.state = i < streak ? 'streak' : i < samples.length ? 'kept' : 'empty';
    // Each slot carries its own hue, so eight samples read as eight things.
    cell.dataset.slot = String(i + 1);
    strip.append(cell);
  }
}

function renderTeach(): void {
  const kicker = $('[data-teach-kicker]');
  const title = $('[data-teach-title]');
  if (kicker !== null)
    kicker.textContent = `Stage 1 · Teach · Level ${level} of ${SAMPLES_REQUIRED}`;
  if (title !== null) {
    title.textContent =
      TEACH_TITLES[level] ?? (level >= 5 ? TEACH_TITLES[5] : TEACH_TITLES[2]) ?? '';
  }
  rail('enrolled', `${samples.length} / ${SAMPLES_REQUIRED}`);
  renderStreak();
}

/* ---- calibrate ------------------------------------------------------------- */

function randomPhrase(): string {
  const picked: string[] = [];
  while (picked.length < 4) {
    const word = WORDS[Math.floor(Math.random() * WORDS.length)];
    if (word !== undefined && !picked.includes(word)) picked.push(word);
  }
  return picked.join(' ');
}

function initCalibrate(): void {
  const stage = stageOf('calibrate');
  const randomOut = $('[data-random-phrase]', stage) as HTMLElement;
  const ownInput = $<HTMLInputElement>('[data-own-phrase]', stage) as HTMLInputElement;
  const error = $('[data-error]', stage) as HTMLElement;

  randomOut.textContent = randomPhrase();

  /**
   * One place decides which card is chosen, and the radio is the source of truth.
   *
   * Everything that can select a card — the radio itself, a click anywhere on it,
   * focusing the text field, shuffling — routes through here, so the border, the radio
   * and `usingOwnPhrase` cannot disagree. They did: focus moved without the border
   * following it.
   */
  const setChoice = (own: boolean) => {
    usingOwnPhrase = own;
    for (const card of $$('[data-choice]', stage)) {
      const chosen = card.dataset.choice === (own ? 'own' : 'random');
      card.dataset.selected = String(chosen);
      const radio = $<HTMLInputElement>('.ck-choice-radio', card);
      if (radio !== null) radio.checked = chosen;
    }
  };

  for (const radio of $$<HTMLInputElement>('.ck-choice-radio', stage)) {
    radio.addEventListener('change', () => setChoice(radio.value === 'own'));
  }

  for (const card of $$('[data-choice]', stage)) {
    card.addEventListener('click', (event) => {
      // Shuffle picks a new phrase; it should not also be a way to change the answer to
      // "which card", beyond selecting the one it lives in.
      if ((event.target as HTMLElement).closest('[data-shuffle]') !== null) return;
      setChoice(card.dataset.choice === 'own');
      if (card.dataset.choice === 'own') ownInput.focus();
    });
  }

  $('[data-shuffle]', stage)?.addEventListener('click', () => {
    randomOut.textContent = randomPhrase();
    setChoice(false);
  });

  // Reaching the field by any route is a choice of that card. This is the tab case.
  ownInput.addEventListener('focus', () => setChoice(true));

  $('[data-begin]', stage)?.addEventListener('click', () => {
    const chosen = usingOwnPhrase ? ownInput.value.trim() : (randomOut.textContent ?? '');
    if (chosen.length < MIN_PHRASE) {
      error.hidden = false;
      error.textContent = `That is ${chosen.length} characters. Use at least ${MIN_PHRASE}.`;
      return;
    }
    error.hidden = true;
    phrase = chosen;
    log(`phrase set · ${phrase.length} chars`, 'green');
    rail('tokens', String(scriptLength(phrase)));
    show('teach');
    renderTeach();
  });
}

/* ---- teach ------------------------------------------------------------------ */

function submitTeach(): void {
  const stage = stageOf('teach');
  const feedback = $('[data-feedback]', stage) as HTMLElement;
  const taken = takeSample();

  if (typeof taken === 'string') {
    feedback.textContent = `${taken} Escape clears the box.`;
    setLight('refused');
    log('sample rejected', 'amber');
    resetSample('refused');
    return;
  }

  // Sample one fixes the canonical script. Everything after it is measured against that,
  // because a different key sequence is a different secret rather than a worse attempt.
  if (canonicalScript === null) {
    canonicalScript = taken.script;
    rail('tokens', String(scriptLength(canonicalScript)));
    const ranges = getFeatureRanges(scriptLength(canonicalScript));
    rail('vector', String(ranges.totalLength));
    rail('dwell', String(scriptLength(canonicalScript)));
    rail('flight', String(Math.max(0, scriptLength(canonicalScript) - 1)));
    rail('digraph', String(Math.max(0, scriptLength(canonicalScript) - 1)));
  } else if (!scriptsEqual(canonicalScript, taken.script)) {
    streak = 0;
    resets += 1;
    const delta = describeScriptDelta(canonicalScript, taken.script);
    feedback.textContent = `Different keystrokes that time — ${delta}. Kept, but the run resets.`;
    // The phantom readout is about the sample just described, so it moves with it rather
    // than sitting on the previous sample's count and contradicting the sentence above.
    const phantomOut = $('[data-phantom]', stage);
    if (phantomOut !== null) {
      phantomOut.textContent = String(Math.max(0, scriptLength(taken.script) - phrase.length));
    }
    setLight('amber');
    log(`sample rejected · ${delta}`, 'amber');
    renderStreak();
    resetSample('refused');
    return;
  }

  const phantom = scriptLength(taken.script) - phrase.length;
  if (phantom <= 0) phantomEverySample = false;
  const phantomOut = $('[data-phantom]', stage);
  if (phantomOut !== null) phantomOut.textContent = String(Math.max(0, phantom));

  samples.push(taken.vector);
  streak += 1;
  level = samples.length + 1;

  const stats = summarise(taken.vector);
  rail('total', blurMs(stats.total));
  rail('cur-dwell', blurMs(stats.dwell));
  rail('cur-flight', blurMs(stats.flight));
  rail('cur-phantom', String(Math.max(0, phantom)));
  log(
    `sample ${samples.length}/${SAMPLES_REQUIRED} accepted · n=${scriptLength(taken.script)}${phantom > 0 ? ` · ${phantom} phantom` : ''}`,
    'train',
    samples.length,
  );
  setLight('captured');
  feedback.textContent = '';

  if (samples.length >= SAMPLES_REQUIRED) {
    forgeProfile();
    return;
  }

  renderTeach();
  resetSample('refused');
}

/* ---- forge ------------------------------------------------------------------- */

function forgeProfile(): void {
  profile = buildProfile(samples);
  consistency = consistencyOf(profile);

  const hudConsistency = $('[data-hud-consistency]');
  if (hudConsistency !== null) hudConsistency.textContent = `${consistency}%`;

  const ranges = getFeatureRanges(profile.len);
  const sigma = mean(profile.stds.slice(ranges.dwell[0], ranges.flight[1]));
  rail('sigma', blurMs(sigma));
  rail('enrolled', `${samples.length} / ${SAMPLES_REQUIRED}`);

  const dwellMeans = profile.means.slice(ranges.dwell[0], ranges.dwell[1]);
  const flightMeans = profile.means.slice(ranges.flight[0], ranges.flight[1]);
  setText('[data-stat-dims]', String(ranges.totalLength));
  setText('[data-stat-dwell]', blurMs(mean(dwellMeans)));
  setText('[data-stat-flight]', blurMs(mean(flightMeans)));
  setText('[data-stat-consistency]', `${consistency}%`);

  paintEnvelope(profile);

  /*
    The samples are dropped here, and the page says so on screen.

    It is one line of code and it is the whole data-minimisation argument: after this
    point the only thing in memory is means and floored variances, which cannot be
    replayed as typing.
  */
  samples = [];
  log('profile forged · raw events destroyed', 'green');

  if (consistency >= 90) unlock('metronome');
  if (resets === 0) unlock('sweep');
  if (phantomEverySample) unlock('phantom');

  renderStreak();
  show('forged');
}

function setText(sel: string, value: string): void {
  const el = $(sel);
  if (el !== null) el.textContent = value;
}

function paintEnvelope(built: Profile): void {
  const chart = $('[data-envelope]');
  if (chart === null) return;
  chart.replaceChildren();

  const ranges = getFeatureRanges(built.len);
  const means = built.means.slice(ranges.dwell[0], ranges.dwell[1]);
  const stds = built.stds.slice(ranges.dwell[0], ranges.dwell[1]);
  const peak = Math.max(...means.map((m, i) => m + (stds[i] ?? 0)), 1);

  means.forEach((mu, i) => {
    const sigma = stds[i] ?? 0;
    const column = document.createElement('span');
    column.className = 'ck-envelope-col';
    // The band is ±1σ drawn around the mean: the shape of "how repeatable is this key".
    column.style.setProperty('--mu', `${(mu / peak) * 100}%`);
    column.style.setProperty('--band', `${Math.max(2, ((2 * sigma) / peak) * 100)}%`);
    chart.append(column);
  });
}

/* ---- attempts ------------------------------------------------------------------ */

function recordAttempt(vector: FeatureVector, script: string): Attempt {
  const stats = summarise(vector);
  return {
    vector,
    tokens: scriptLength(script),
    totalMs: stats.total,
    meanDwell: stats.dwell,
    meanFlight: stats.flight,
    scriptMatched: canonicalScript !== null && scriptsEqual(canonicalScript, script),
  };
}

function submitIntruder(): void {
  const stage = stageOf('intruder');
  const feedback = $('[data-feedback]', stage) as HTMLElement;
  const taken = takeSample();
  if (typeof taken === 'string') {
    feedback.textContent = `${taken} Escape clears the box.`;
    resetSample('refused');
    return;
  }

  const attempt = recordAttempt(taken.vector, taken.script);
  intruderAttempts.push(attempt);
  intruderTriesUsed += 1;

  const verdict = judge(attempt);
  log(
    `intruder attempt → ${verdict.toUpperCase()}`,
    verdict === 'pass' ? 'green' : verdict === 'grey' ? 'amber' : 'fail',
  );
  setLight(verdict === 'pass' ? 'matched' : verdict === 'grey' ? 'amber' : 'refused');

  const counter = $('[data-attempt]', stage);
  if (counter !== null)
    counter.textContent = String(Math.min(INTRUDER_ATTEMPTS, intruderTriesUsed + 1));

  if (verdict === 'pass' || intruderTriesUsed >= INTRUDER_ATTEMPTS) {
    show('you');
    return;
  }

  feedback.textContent =
    verdict === 'grey'
      ? 'Amber. Looks a little different. Once more.'
      : 'Refused. That did not match the rhythm.';
  resetSample('refused');
}

function submitYou(): void {
  const stage = stageOf('you');
  const feedback = $('[data-feedback]', stage) as HTMLElement;
  const taken = takeSample();
  if (typeof taken === 'string') {
    feedback.textContent = `${taken} Escape clears the box.`;
    resetSample('refused');
    return;
  }

  yourAttempt = recordAttempt(taken.vector, taken.script);
  const verdict = judge(yourAttempt);
  log(
    `you → ${verdict.toUpperCase()}`,
    verdict === 'pass' ? 'green' : verdict === 'grey' ? 'amber' : 'fail',
  );
  setLight(verdict === 'pass' ? 'matched' : verdict === 'grey' ? 'amber' : 'refused');

  if (verdict === 'pass' && yourFirstTry) unlock('homecoming');
  yourFirstTry = false;

  if (intruderAttempts.length > 0 && intruderAttempts.every((a) => judge(a) === 'fail')) {
    unlock('gatekeeper');
  }

  renderVerdict();
  show('verdict');
}

function judge(attempt: Attempt): 'pass' | 'grey' | 'fail' {
  // A script mismatch is refused before scoring: the Phantom Keys were not reproduced,
  // so this is a different secret and no amount of rhythm rescues it.
  if (!attempt.scriptMatched || profile === null) return 'fail';
  if (attempt.vector.len !== profile.len) return 'fail';
  const bands = rhythmBands(strictness);
  return band(score(profile, attempt.vector), bands.pass, bands.grey);
}

/* ---- verdict -------------------------------------------------------------------- */

const SENTENCE = {
  pass: {
    headline: 'Rhythm matched.',
    body: 'Vault key would be unwrapped. No extra step, no device.',
  },
  grey: {
    headline: 'Looks a little different.',
    body: 'One retype is asked for, then a passkey, TOTP or Backup Code. The vault is not at risk either way.',
  },
  fail: {
    headline: "That didn't match the rhythm.",
    body: 'Same characters, different dwell and flight. The server share is not released.',
  },
  mismatch: {
    headline: "That didn't match the rhythm.",
    body: 'Different number of keystrokes: the Phantom Keys were missing. The server share is not released.',
  },
} as const;

function renderVerdictCard(which: 'intruder' | 'you', attempt: Attempt | null): void {
  const card = $(`[data-verdict="${which}"]`);
  if (card === null) return;
  const bandOut = $('[data-band]', card) as HTMLElement;
  const headline = $('[data-headline]', card) as HTMLElement;
  const sentence = $('[data-sentence]', card) as HTMLElement;
  const foot = $('[data-foot]', card) as HTMLElement;

  if (attempt === null) {
    bandOut.textContent = '—';
    bandOut.dataset.band = 'none';
    headline.textContent = 'No attempt recorded';
    sentence.textContent = '';
    foot.textContent = '';
    return;
  }

  const verdict = judge(attempt);
  const copy = verdict === 'fail' && !attempt.scriptMatched ? SENTENCE.mismatch : SENTENCE[verdict];
  bandOut.textContent = verdict === 'pass' ? 'PASSED' : verdict === 'grey' ? 'AMBER' : 'REFUSED';
  bandOut.dataset.band = verdict;
  headline.textContent = copy.headline;
  sentence.textContent = copy.body;
  foot.textContent = `n=${attempt.tokens} · total ${blurMs(attempt.totalMs)} · mean dwell ${blurMs(attempt.meanDwell)} · mean flight ${blurMs(attempt.meanFlight)}`;
}

function renderVerdict(): void {
  renderVerdictCard('intruder', intruderAttempts.at(-1) ?? null);
  renderVerdictCard('you', yourAttempt);
  if (yourAttempt !== null && strictness === 'strict' && judge(yourAttempt) === 'pass') {
    unlock('strict');
  }
}

/* ---- achievements ----------------------------------------------------------------- */

function unlock(name: string): void {
  if (unlocked.has(name)) return;
  unlocked.add(name);
  const chip = $(`[data-ach="${name}"]`);
  if (chip !== null) chip.dataset.unlocked = 'true';
  log(`achievement · ${name}`, 'green');
}

/* ---- wiring ------------------------------------------------------------------------ */

function reset(): void {
  disarmCapture();
  phrase = '';
  canonicalScript = null;
  samples = [];
  profile = null;
  level = 1;
  streak = 0;
  resets = 0;
  phantomEverySample = true;
  consistency = null;
  intruderAttempts = [];
  intruderTriesUsed = 0;
  yourAttempt = null;
  yourFirstTry = true;
  liveKeys = [];
  logList.replaceChildren();
  for (const key of [
    'tokens',
    'vector',
    'dwell',
    'flight',
    'digraph',
    'sigma',
    'total',
    'cur-dwell',
    'cur-flight',
    'cur-phantom',
  ]) {
    rail(key, '—');
  }
  rail('enrolled', `0 / ${SAMPLES_REQUIRED}`);
  setText('[data-hud-consistency]', '—');
  setText('[data-hud-keys]', '0 / 0');
  renderStreak();
  const randomOut = $('[data-random-phrase]');
  if (randomOut !== null) randomOut.textContent = randomPhrase();
  show('calibrate');
  log('trial reset');
}

initCalibrate();
renderStreak();
rail('enrolled', `0 / ${SAMPLES_REQUIRED}`);

$('[data-reset]')?.addEventListener('click', reset);

$('[data-to-intruder]')?.addEventListener('click', () => {
  intruderTriesUsed = 0;
  show('intruder');
});
$('[data-give-up]')?.addEventListener('click', () => show('you'));
$('[data-again-intruder]')?.addEventListener('click', () => {
  intruderTriesUsed = 0;
  const counter = $('[data-attempt]', stageOf('intruder'));
  if (counter !== null) counter.textContent = '1';
  show('intruder');
});
$('[data-again-you]')?.addEventListener('click', () => show('you'));

for (const button of $$('[data-submit-sample]')) {
  // `mousedown` would blur the field and void the sample the click is submitting.
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => {
    if (phase === 'teach') submitTeach();
    else if (phase === 'intruder') submitIntruder();
    else if (phase === 'you') submitYou();
  });
}

for (const input of $$<HTMLInputElement>('[data-type-input]')) {
  input.addEventListener('focus', () => {
    if (handle === null) armCapture();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // Ahead of core's own Escape handling, which records it as a token. The sample is
      // being discarded, so what it recorded does not matter.
      event.preventDefault();
      resetSample('escape');
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (phase === 'teach') submitTeach();
    else if (phase === 'intruder') submitIntruder();
    else if (phase === 'you') submitYou();
  });
}

for (const button of $$('[data-strictness]')) {
  button.addEventListener('click', () => {
    strictness = button.dataset.strictness as Strictness;
    for (const other of $$('[data-strictness]')) {
      other.setAttribute('aria-pressed', String(other === button));
    }
    rail('strictness', strictness);
    log(`strictness → ${strictness}`);
    renderVerdict();
  });
}
