import type { AuthedRequest } from './session';

/**
 * Client for `/enroll/*` (A-9). Enrollment runs under a scope-`enroll` bearer token
 * issued by signup, not under a session access token, so it is a separate client from
 * `createSession` rather than another method on it.
 */
export type EnrollDeps = {
  /** From `session.authed()`; signs each request with the device key (A-3). */
  request: AuthedRequest;
  /** The `enrollmentToken` returned by signup. */
  token: string;
};

export type EnrollStatus = {
  required: number;
  submitted: number;
  remaining: number;
  /** True once `/enroll/build` has turned the samples into a profile. */
  built: boolean;
};

export type EnrollSample = {
  featureVector: number[];
  /** A-14.2, one per script token and in order. The server checks the count. */
  commitments: string[];
};

export type Enroller = {
  status(): Promise<EnrollStatus>;
  sample(input: EnrollSample): Promise<{ samplesRemaining: number }>;
  build(): Promise<{ built: true; scriptLen: number; sampleCount: number }>;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('malformed server response');
  return value as Record<string, unknown>;
}

/**
 * Turns a non-2xx into an error carrying the server's reason. M1-18 gave every
 * enrollment rejection a distinct reason precisely so a stuck user can be told which
 * rule they hit; collapsing them back to a status code here would undo that.
 */
function raise(path: string, status: number, body: unknown): never {
  const reason = asRecord(body).error;
  throw new Error(typeof reason === 'string' ? reason : `${path} failed with status ${status}`);
}

function num(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`malformed server response: ${field}`);
  }
  return value;
}

export function createEnroller(deps: EnrollDeps): Enroller {
  const { request, token } = deps;

  return {
    async status() {
      const { status, body } = await request('GET', '/enroll/status', undefined, token);
      if (status !== 200) raise('/enroll/status', status, body);
      const r = asRecord(body);
      return {
        required: num(r.required, 'required'),
        submitted: num(r.submitted, 'submitted'),
        remaining: num(r.remaining, 'remaining'),
        built: r.built === true,
      };
    },

    async sample(input) {
      const { status, body } = await request(
        'POST',
        '/enroll/sample',
        { featureVector: input.featureVector, commitments: input.commitments },
        token,
      );
      if (status !== 200) raise('/enroll/sample', status, body);
      return { samplesRemaining: num(asRecord(body).samplesRemaining, 'samplesRemaining') };
    },

    async build() {
      const { status, body } = await request('POST', '/enroll/build', {}, token);
      if (status !== 200) raise('/enroll/build', status, body);
      const r = asRecord(body);
      return {
        built: true,
        scriptLen: num(r.scriptLen, 'scriptLen'),
        sampleCount: num(r.sampleCount, 'sampleCount'),
      };
    },
  };
}
