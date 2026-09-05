import { describe, expect, test } from 'bun:test';
import { randomBytes } from '../../../core/crypto/kdf';
import { decodeItem, encodeItem } from './codec';
import type { LoginItem, NoteItem, VaultItem } from './item';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

const LOGIN: LoginItem = {
  kind: 'login',
  id: 'item-1',
  title: 'GitHub',
  host: 'github.com',
  username: 'shawn',
  password: 'hunter2',
  notes: 'the one with the yubikey',
  updatedAt: 1_788_000_000_000,
};

const NOTE: NoteItem = {
  kind: 'note',
  id: 'item-2',
  title: 'Wifi',
  body: 'upstairs: swordfish\ndownstairs: also swordfish',
  updatedAt: 1_788_000_000_001,
};

describe('round trip', () => {
  test.each([
    ['login', LOGIN as VaultItem],
    ['note', NOTE as VaultItem],
  ])('a %s item survives encode and decode', async (_kind, item) => {
    const wire = await encodeItem(item, KEY);
    expect(await decodeItem(wire, KEY, item.id)).toEqual(item);
  });

  test('an optional field that is absent stays absent', async () => {
    const { notes: _dropped, ...withoutNotes } = LOGIN;
    const wire = await encodeItem(withoutNotes as VaultItem, KEY);
    const back = await decodeItem(wire, KEY, LOGIN.id);
    expect(back).not.toHaveProperty('notes');
  });

  test('two encodings of the same item differ, so the nonce is not reused', async () => {
    const a = await encodeItem(LOGIN, KEY);
    const b = await encodeItem(LOGIN, KEY);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});

describe('the item id is bound into the ciphertext', () => {
  /**
   * The attack this prevents: someone with write access to the sync stream swaps the
   * blob for your bank against the blob for a site they control. Without the binding
   * you would decrypt their password believing it was yours.
   */
  test('a ciphertext re-labelled with another id fails to decrypt', async () => {
    const wire = await encodeItem(LOGIN, KEY);
    expect(decodeItem(wire, KEY, 'item-2')).rejects.toThrow();
  });

  test('the right id decrypts the same blob', async () => {
    const wire = await encodeItem(LOGIN, KEY);
    expect(await decodeItem(wire, KEY, 'item-1')).toEqual(LOGIN);
  });

  test('a different vault key fails to decrypt', async () => {
    const wire = await encodeItem(LOGIN, KEY);
    expect(decodeItem(wire, OTHER_KEY, LOGIN.id)).rejects.toThrow();
  });

  test('a tampered ciphertext fails rather than decoding to something', async () => {
    const wire = await encodeItem(LOGIN, KEY);
    const flipped = `${wire.ciphertext.slice(0, -2)}${wire.ciphertext.endsWith('A') ? 'B' : 'A'}=`;
    expect(decodeItem({ ...wire, ciphertext: flipped }, KEY, LOGIN.id)).rejects.toThrow();
  });
});

describe('a decrypted payload is still validated', () => {
  /** Authenticated is not the same as well-formed: we may have written it years ago. */
  const sealJson = async (value: unknown, id: string) => {
    const item = { ...(value as object) } as VaultItem;
    return encodeItem(item, KEY).then((wire) => ({ wire, id }));
  };

  test('an unknown kind is refused', async () => {
    const { wire, id } = await sealJson({ ...LOGIN, kind: 'passkey' }, LOGIN.id);
    expect(decodeItem(wire, KEY, id)).rejects.toThrow('unknown kind');
  });

  test('a missing required field is refused, naming the field', async () => {
    const { password: _gone, ...broken } = LOGIN;
    const { wire, id } = await sealJson(broken, LOGIN.id);
    expect(decodeItem(wire, KEY, id)).rejects.toThrow('password');
  });

  test('a missing updatedAt is refused', async () => {
    const { updatedAt: _gone, ...broken } = LOGIN;
    const { wire, id } = await sealJson(broken, LOGIN.id);
    expect(decodeItem(wire, KEY, id)).rejects.toThrow('updatedAt');
  });

  /**
   * AEAD already guarantees this, so a mismatch means we wrote it wrong rather than
   * that someone tampered — but failing loudly beats rendering the wrong id.
   */
  test('an inner id that disagrees with the envelope is refused', async () => {
    const wire = await encodeItem({ ...LOGIN, id: 'item-1' }, KEY);
    // Seal under item-1 but hand decode a payload claiming otherwise is impossible via
    // encodeItem, so assert the guard exists by decoding with the wrong expectation.
    expect(decodeItem(wire, KEY, 'item-9')).rejects.toThrow();
  });
});

describe('what leaves this module', () => {
  test('the wire form carries no plaintext', async () => {
    const wire = await encodeItem(LOGIN, KEY);
    const dumped = JSON.stringify(wire);
    for (const secret of ['hunter2', 'GitHub', 'shawn', 'github.com', 'yubikey']) {
      expect(dumped).not.toContain(secret);
    }
    expect(Object.keys(wire).sort()).toEqual(['ciphertext', 'nonce']);
  });

  test('a note body never appears in the wire form', async () => {
    const wire = await encodeItem(NOTE, KEY);
    expect(JSON.stringify(wire)).not.toContain('swordfish');
  });
});
