import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The production entrypoint, actually started.
 *
 * Every other test in this directory builds its own app and hands it whatever it needs.
 * That is the right shape for testing routes, and it is blind by construction to the one
 * thing that keeps going wrong here: a seam the tests supply and `index.ts` does not.
 *
 * It has now happened twice. `createApp({ db })` without a config left the deployed
 * server mounting only `/healthz`. And `RESEND_API_KEY` sat in the Secret Manager plan
 * while no line of code read it, so M2-15's email could never have been switched on --
 * `createMailer` and `resendTransport` were written, tested, and never constructed.
 *
 * So this boots the real file and reads what it says about itself.
 */

const ENTRYPOINT = join(import.meta.dir, 'index.ts');
const SECRET = 'x'.repeat(48);

/** A port unlikely to collide with a developer's own server, or another test file's. */
const port = () => 21_000 + Math.floor(Math.random() * 4_000);

type Boot = { stdout: string; stderr: string; exitCode: number | null };

/**
 * Starts the entrypoint, waits for it to say something, and kills it.
 *
 * Resolves as soon as the boot line appears rather than after a fixed sleep: a server
 * that starts fast should not cost a second, and one that never starts should fail on
 * the timeout rather than on an empty string.
 */
async function boot(extra: Record<string, string>, timeoutMs = 15_000): Promise<Boot> {
  const dir = mkdtempSync(join(tmpdir(), 'ck-boot-'));
  const proc = Bun.spawn(['bun', ENTRYPOINT], {
    cwd: join(import.meta.dir, '..', '..'),
    env: {
      ...process.env,
      JWT_SECRET: SECRET,
      DATABASE_URL: `sqlite://${join(dir, 'boot.db')}`,
      PORT: String(port()),
      // Inherited variables would decide the answer for us: a developer with a real key
      // in their shell would see this pass for the wrong reason.
      RESEND_API_KEY: '',
      MAIL_FROM: '',
      ...extra,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let stdout = '';
  let stderr = '';
  // A reader loop rather than `for await`: Bun iterates a ReadableStream happily, but
  // the TypeScript lib does not declare an async iterator on it.
  const reader = async (stream: ReadableStream<Uint8Array>, onChunk: (s: string) => void) => {
    const decoder = new TextDecoder();
    const source = stream.getReader();
    while (true) {
      const { done, value } = await source.read();
      if (done) return;
      if (value !== undefined) onChunk(decoder.decode(value));
    }
  };
  const pumping = Promise.all([
    reader(proc.stdout, (s) => {
      stdout += s;
    }),
    reader(proc.stderr, (s) => {
      stderr += s;
    }),
  ]);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stdout.includes('cypherkey:') || stderr.includes('cypherkey:')) break;
    if (proc.exitCode !== null) break;
    await Bun.sleep(25);
  }

  proc.kill();
  await proc.exited.catch(() => {});
  await pumping.catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  return { stdout, stderr, exitCode: proc.exitCode };
}

describe('the entrypoint wires the mailer it is configured for', () => {
  test('with no provider it says so, and still starts', async () => {
    const result = await boot({});

    expect(result.stdout).toContain('mail is off');
    expect(result.stdout).toContain('RESEND_API_KEY');
    // Not sending mail is not a reason to refuse logins.
    expect(result.exitCode).not.toBe(1);
  });

  /**
   * The assertion that was missing. It cannot check that a message reaches Resend --
   * that is `mail.test.ts`, over an injected fetch -- but it proves the entrypoint read
   * the variable and built something out of it, which is exactly what it did not do.
   */
  test('with a provider it reports mail on, and names the sender', async () => {
    const result = await boot({
      RESEND_API_KEY: 're_test_key',
      MAIL_FROM: 'CypherKey <noreply@cypherkey.io>',
    });

    expect(result.stdout).toContain('mail is on');
    expect(result.stdout).toContain('noreply@cypherkey.io');
  });

  test('the boot line never carries the key', async () => {
    const result = await boot({
      RESEND_API_KEY: 're_the_actual_secret',
      MAIL_FROM: 'noreply@cypherkey.io',
    });

    expect(`${result.stdout}${result.stderr}`).not.toContain('re_the_actual_secret');
  });

  /** Half-configured mail is the state where an operator believes it is on. */
  test('a key with no sender refuses to start', async () => {
    const result = await boot({ RESEND_API_KEY: 're_test_key' });

    expect(result.stderr).toContain('refusing to start');
    expect(result.stderr).toContain('MAIL_FROM');
    expect(result.exitCode).toBe(1);
  });
});
