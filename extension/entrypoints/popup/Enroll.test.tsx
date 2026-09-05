import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BACKSPACE } from '../../../core/biometrics/script';
import type { AuthedRequest, Session } from '../../../core/client/session';
import { Enroll, MISMATCH_MESSAGE } from './Enroll';

let win: Window;
let host: ReturnType<Window['document']['createElement']>;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  win = new Window();
  for (const key of [
    'window',
    'document',
    'HTMLElement',
    'Element',
    'Node',
    'navigator',
    'MouseEvent',
    'KeyboardEvent',
    'Event',
  ]) {
    (globalThis as Record<string, unknown>)[key] = (win as unknown as Record<string, unknown>)[key];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = win.document.createElement('div');
  win.document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

/**
 * A server that keeps the sample count, so the ring is driven by what the account
 * actually holds rather than by anything this screen remembers.
 */
function fakeServer(options: { required?: number; startAt?: number } = {}) {
  const required = options.required ?? 8;
  const state = {
    submitted: options.startAt ?? 0,
    built: false,
    vectors: [] as number[][],
    commitments: [] as string[][],
    rejectNext: null as string | null,
  };

  const request: AuthedRequest = async (_method, path, body) => {
    const json = (status: number, value: unknown) => ({ status, body: value });
    if (path === '/enroll/status') {
      return json(200, {
        required,
        submitted: state.submitted,
        remaining: state.built ? 0 : Math.max(0, required - state.submitted),
        built: state.built,
      });
    }
    if (path === '/enroll/sample') {
      if (state.rejectNext !== null) {
        const error = state.rejectNext;
        state.rejectNext = null;
        return json(400, { error });
      }
      if (state.submitted >= required) return json(409, { error: 'enough_samples' });
      const payload = body as { featureVector: number[]; commitments: string[] };
      state.vectors.push(payload.featureVector);
      state.commitments.push(payload.commitments);
      state.submitted += 1;
      return json(200, { samplesRemaining: required - state.submitted });
    }
    if (path === '/enroll/build') {
      state.built = true;
      // A-4.6: the server deletes the samples once the profile exists.
      state.vectors = [];
      return json(200, { built: true, scriptLen: 13, sampleCount: state.submitted });
    }
    return json(404, { error: 'not_found' });
  };

  const session: Pick<Session, 'authed' | 'commitmentsFor'> = {
    authed: () => request,
    commitmentsFor: async (script) => [...script].map((_, i) => `c${i}`),
  };
  return { session, state };
}

const el = (id: string) => host.querySelector(`[data-testid="${id}"]`);

const render = async (
  session: Pick<Session, 'authed' | 'commitmentsFor'>,
  props: { script?: string } = {},
) => {
  const built: Array<{ scriptLen: number; sampleCount: number }> = [];
  await act(async () => {
    root.render(
      <Enroll
        session={session}
        enrollmentToken="enroll-token-1"
        onBuilt={(r) => built.push(r)}
        {...props}
      />,
    );
  });
  return built;
};

const PHRASE = [...'correct horse'];
/** The same resolved text with a Phantom Key: a doubled r that is corrected away. */
const WITH_PHANTOM = [...'corr', 'r', 'Backspace', ...'ect horse'];

const typeAndSubmit = async (keys: string[]) => {
  const field = el('passphrase');
  await act(async () => field?.dispatchEvent(new win.Event('focusin', { bubbles: true })));
  for (const key of keys) {
    await act(async () => {
      field?.dispatchEvent(
        new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
      field?.dispatchEvent(
        new win.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }),
      );
    });
  }
  await act(async () => {
    el('submit')?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });
};

describe('progress comes from the server', () => {
  test('the ring starts from what the account already holds', async () => {
    const { session } = fakeServer({ startAt: 3 });
    await render(session);
    expect(el('ring')?.getAttribute('data-submitted')).toBe('3');
    expect(el('ring')?.getAttribute('data-required')).toBe('8');
  });

  /**
   * A popup closed mid-enrolment must resume where the account is. A local counter
   * would either restart at zero or claim samples the server never received.
   */
  test('a reload mid-enrolment resumes rather than restarting', async () => {
    const { session, state } = fakeServer({ startAt: 5 });
    await render(session);
    expect(el('ring')?.getAttribute('data-submitted')).toBe('5');

    await typeAndSubmit(PHRASE);
    expect(el('ring')?.getAttribute('data-submitted')).toBe('6');
    expect(state.submitted).toBe(6);
  });

  test('each accepted sample advances the ring', async () => {
    const { session } = fakeServer();
    await render(session, { script: 'correct horse' });

    for (let i = 1; i <= 3; i++) {
      await typeAndSubmit(PHRASE);
      expect(el('ring')?.getAttribute('data-submitted')).toBe(String(i));
    }
  });
});

describe('a script mismatch retries without consuming a sample', () => {
  test('caught locally when the script is known', async () => {
    const { session, state } = fakeServer();
    await render(session, { script: 'correct horse' });

    await typeAndSubmit(WITH_PHANTOM);

    expect(el('message')?.textContent).toBe(MISMATCH_MESSAGE);
    // Nothing was sent: no round trip is spent on a mismatch we can already see.
    expect(state.submitted).toBe(0);
  });

  /**
   * On a resumed popup the script is not known - it is never persisted - so the server
   * is the judge. Its `script_mismatch` must read as the same thing to the user.
   */
  test('the server script_mismatch reads the same as a local one', async () => {
    const { session, state } = fakeServer();
    state.rejectNext = 'script_mismatch';
    await render(session); // no script prop: resumed

    await typeAndSubmit(PHRASE);
    expect(el('message')?.textContent).toBe(MISMATCH_MESSAGE);
    expect(state.submitted).toBe(0);
  });

  test('a mismatch is followed by a normal successful sample', async () => {
    const { session, state } = fakeServer();
    await render(session, { script: 'correct horse' });

    await typeAndSubmit(WITH_PHANTOM);
    await typeAndSubmit(PHRASE);

    expect(state.submitted).toBe(1);
    expect(el('ring')?.getAttribute('data-submitted')).toBe('1');
  });

  /**
   * Backspace is a legitimate Phantom Key, so a sample containing one is not an error.
   * "Backspace retry" was withdrawn for exactly this reason.
   */
  test('a passphrase that contains Backspace enrolls normally', async () => {
    const { session, state } = fakeServer();
    // Named constant, not a literal control byte: an invisible 0x08 in source is
    // unreadable in a diff and indistinguishable from an empty string in most tools,
    // which is exactly how it gets 'corrected' into a test that proves nothing.
    const enrolledScript = ['corr', 'r', BACKSPACE, 'ect horse'].join('');
    await render(session, { script: enrolledScript });

    await typeAndSubmit(WITH_PHANTOM);
    expect(state.submitted).toBe(1);
    expect(el('message')).toBeNull();
  });
});

describe('completing enrolment', () => {
  test('an extra sample beyond the required count cannot be sent', async () => {
    const { session, state } = fakeServer({ required: 2 });
    await render(session, { script: 'correct horse' });

    await typeAndSubmit(PHRASE);
    await typeAndSubmit(PHRASE);

    expect(state.submitted).toBe(2);
    // There is no submit control left to over-send with.
    expect(el('submit')).toBeNull();
    expect(el('build')).not.toBeNull();
  });

  test('building reports the profile and says the samples are deleted', async () => {
    const { session, state } = fakeServer({ required: 1 });
    const built = await render(session, { script: 'correct horse' });

    await typeAndSubmit(PHRASE);
    expect(host.textContent).toContain('deleted');

    await act(async () => {
      el('build')?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    });

    expect(built).toHaveLength(1);
    expect(built[0]?.sampleCount).toBe(1);
    expect(state.vectors).toHaveLength(0);
  });
});

describe('what the screen asks for, and what it sends', () => {
  /**
   * Measured during M2-00g: six natural samples plus one slow and one fast raised the
   * median feature spread from 8 ms to 21 ms and lifted a stranger from a clear fail
   * to a comfortable pass. A wider band cannot tell anyone apart.
   */
  test('it never asks for deliberately fast or slow samples', async () => {
    const { session } = fakeServer();
    await render(session);
    const text = (host.textContent ?? '').toLowerCase();
    expect(text).not.toContain('slowly');
    expect(text).not.toContain('quickly');
    expect(text).not.toContain('as fast as');
    expect(text).toContain('the way you normally would');
  });

  test('every sample carries one commitment per script token', async () => {
    const { session, state } = fakeServer();
    await render(session, { script: 'correct horse' });
    await typeAndSubmit(PHRASE);

    expect(state.commitments[0]).toHaveLength('correct horse'.length);
    expect(state.vectors[0]?.length).toBe(3 * 'correct horse'.length + 5);
  });

  /** Absence: a feature vector is sent and then forgotten, never written down. */
  test('nothing is persisted anywhere by this screen', async () => {
    const { session } = fakeServer();
    await render(session, { script: 'correct horse' });
    await typeAndSubmit(PHRASE);

    expect(Object.keys(win.localStorage ?? {})).toHaveLength(0);
    expect(Object.keys(win.sessionStorage ?? {})).toHaveLength(0);
  });
});
