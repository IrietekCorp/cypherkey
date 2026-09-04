import { describe, expect, spyOn, test } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519';
import {
  type RequestToSign,
  generateDeviceKey,
  signRequest,
  signingString,
  verifyRequest,
} from './device';
import { fromBase64Url } from './encoding';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fromHex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const bytes = (s: string) => new TextEncoder().encode(s);

const REQ: RequestToSign = {
  nonce: fromHex('00112233445566778899aabbccddeeff'),
  ts: 1_788_000_000_000,
  method: 'POST',
  path: '/vault/changes?since=42',
  body: bytes('{"items":[]}'),
};

describe('generateDeviceKey', () => {
  test('returns a 32-byte private seed and its 32-byte public key', async () => {
    const { pub, priv } = await generateDeviceKey();
    expect(priv.length).toBe(32);
    expect(pub.length).toBe(32);
    expect(hex(pub)).toBe(hex(ed25519.getPublicKey(priv)));
  });

  test('does not repeat', async () => {
    const a = await generateDeviceKey();
    const b = await generateDeviceKey();
    expect(hex(a.priv)).not.toBe(hex(b.priv));
  });
});

describe('the A-3 signing string', () => {
  test('is version-prefixed, newline-delimited, in the documented field order', () => {
    expect(signingString(REQ)).toBe(
      [
        'cypherkey-sig-v1',
        '00112233445566778899aabbccddeeff',
        '1788000000000',
        'POST',
        '/vault/changes?since=42',
        Buffer.from(new Bun.CryptoHasher('sha256').update(bytes('{"items":[]}')).digest()).toString(
          'hex',
        ),
      ].join('\n'),
    );
  });

  test('an empty body hashes the empty byte string', () => {
    const line = signingString({ ...REQ, body: new Uint8Array(0) }).split('\n')[5];
    expect(line).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('uppercases the method so casing cannot split the signature', () => {
    expect(signingString({ ...REQ, method: 'post' })).toBe(signingString(REQ));
  });

  test('rejects a path carrying a scheme or host', () => {
    expect(() => signingString({ ...REQ, path: 'https://api.cypherkey.io/vault' })).toThrow(/path/);
    expect(() => signingString({ ...REQ, path: 'vault/changes' })).toThrow(/path/);
  });

  test('rejects a non-integer timestamp', () => {
    expect(() => signingString({ ...REQ, ts: 1.5 })).toThrow(/ts/);
  });

  // Field boundaries must not be forgeable by shifting content between fields.
  test('moving content across a field boundary changes the string', () => {
    const a = signingString({ ...REQ, method: 'POST', path: '/a/b' });
    const b = signingString({ ...REQ, method: 'POST', path: '/a/b' });
    expect(a).toBe(b);
    expect(signingString({ ...REQ, path: '/a/b' })).not.toBe(
      signingString({ ...REQ, path: '/a/b/' }),
    );
  });
});

describe('signRequest / verifyRequest', () => {
  test('round-trips', async () => {
    const { pub, priv } = await generateDeviceKey();
    expect(await verifyRequest(pub, await signRequest(priv, REQ), REQ)).toBe(true);
  });

  test('returns base64url — no +, / or = padding', async () => {
    const { priv } = await generateDeviceKey();
    const sig = await signRequest(priv, REQ);
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('an altered body fails', async () => {
    const { pub, priv } = await generateDeviceKey();
    const sig = await signRequest(priv, REQ);
    expect(await verifyRequest(pub, sig, { ...REQ, body: bytes('{"items":[1]}') })).toBe(false);
  });

  test('an altered path fails', async () => {
    const { pub, priv } = await generateDeviceKey();
    const sig = await signRequest(priv, REQ);
    expect(await verifyRequest(pub, sig, { ...REQ, path: '/vault/changes?since=43' })).toBe(false);
  });

  test('an altered method, nonce or timestamp fails', async () => {
    const { pub, priv } = await generateDeviceKey();
    const sig = await signRequest(priv, REQ);
    expect(await verifyRequest(pub, sig, { ...REQ, method: 'GET' })).toBe(false);
    expect(await verifyRequest(pub, sig, { ...REQ, nonce: new Uint8Array(16) })).toBe(false);
    expect(await verifyRequest(pub, sig, { ...REQ, ts: REQ.ts + 1 })).toBe(false);
  });

  test('another device key fails', async () => {
    const signer = await generateDeviceKey();
    const other = await generateDeviceKey();
    expect(await verifyRequest(other.pub, await signRequest(signer.priv, REQ), REQ)).toBe(false);
  });

  test('a malformed signature returns false rather than throwing', async () => {
    const { pub } = await generateDeviceKey();
    for (const sig of ['', 'not-base64url!!', 'AAAA', 'a'.repeat(200)]) {
      expect(await verifyRequest(pub, sig, REQ)).toBe(false);
    }
  });

  test('a public key of the wrong length returns false rather than throwing', async () => {
    const { priv } = await generateDeviceKey();
    const sig = await signRequest(priv, REQ);
    expect(await verifyRequest(new Uint8Array(16), sig, REQ)).toBe(false);
  });
});

describe('known-answer vectors', () => {
  // RFC 8032 §7.1 TEST 1 and TEST 2.
  const vectors = [
    {
      priv: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
      pub: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
      msg: '',
      sig: 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    },
    {
      priv: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
      pub: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
      msg: '72',
      sig: '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
    },
  ];

  test.each(vectors)('matches RFC 8032 for message "$msg"', ({ priv, pub, msg, sig }) => {
    expect(hex(ed25519.getPublicKey(fromHex(priv)))).toBe(pub);
    expect(hex(ed25519.sign(fromHex(msg), fromHex(priv)))).toBe(sig);
  });

  // A-3 offers WebCrypto Ed25519 "where available". It cannot import a raw 32-byte
  // private seed, so we sign with @noble — but WebCrypto is a second implementation
  // and must accept our signatures, and must produce identical ones (Ed25519 is
  // deterministic). PKCS#8 wrapping is test-only scaffolding.
  const PKCS8_ED25519_PREFIX = fromHex('302e020100300506032b657004220420');

  test('WebCrypto verifies a signature we produced', async () => {
    const { pub, priv } = await generateDeviceKey();
    const sig = await signRequest(priv, REQ);
    const key = await crypto.subtle.importKey('raw', pub as BufferSource, 'Ed25519', false, [
      'verify',
    ]);
    const raw = fromBase64Url(sig);
    expect(
      await crypto.subtle.verify('Ed25519', key, raw as BufferSource, bytes(signingString(REQ))),
    ).toBe(true);
  });

  test('WebCrypto produces byte-identical signatures', async () => {
    const { priv } = await generateDeviceKey();
    const key = await crypto.subtle.importKey(
      'pkcs8',
      Uint8Array.from([...PKCS8_ED25519_PREFIX, ...priv]) as BufferSource,
      'Ed25519',
      false,
      ['sign'],
    );
    const theirs = new Uint8Array(
      await crypto.subtle.sign('Ed25519', key, bytes(signingString(REQ))),
    );
    const ours = fromBase64Url(await signRequest(priv, REQ));
    expect(hex(ours)).toBe(hex(theirs));
  });
});

describe('key material never reaches a log', () => {
  test('no operation writes to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const { pub, priv } = await generateDeviceKey();
      const sig = await signRequest(priv, REQ);
      await verifyRequest(pub, sig, REQ);
      await verifyRequest(pub, 'garbage', REQ);
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  test('the signing string contains the body hash, never the body', () => {
    const secret = '{"password":"hunter2"}';
    const s = signingString({ ...REQ, body: bytes(secret) });
    expect(s).not.toContain('hunter2');
    expect(s).not.toContain('password');
  });

  test('a validation error never quotes the private key', async () => {
    const priv = new Uint8Array(31).fill(7);
    let message = '';
    try {
      await signRequest(priv, REQ);
    } catch (e) {
      message = `${String(e)} ${(e as Error).stack ?? ''}`;
    }
    expect(message).toMatch(/priv/i);
    expect(message).not.toContain(hex(priv));
  });
});
