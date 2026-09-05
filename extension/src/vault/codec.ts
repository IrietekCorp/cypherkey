import { decryptItem, encryptItem } from '../../../core/crypto/aead';
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from '../../../core/crypto/encoding';
import type { VaultItem } from './item';

/**
 * The only place a vault item is encrypted or decrypted.
 *
 * One place, so that "the AAD is the item id" is a fact rather than a convention. That
 * binding is what stops a ciphertext being moved between items: an attacker with write
 * access to the sync stream could otherwise swap the blob for your bank against the
 * blob for a site they control, and you would decrypt their password believing it was
 * yours.
 */

/** An item as it travels and as it rests: ciphertext and nonce, never plaintext. */
export type ItemWire = { ciphertext: string; nonce: string };

export async function encodeItem(item: VaultItem, vaultKey: Uint8Array): Promise<ItemWire> {
  const sealed = await encryptItem(utf8Encode(JSON.stringify(item)), vaultKey, item.id);
  return { ciphertext: toBase64Url(sealed.ct), nonce: toBase64Url(sealed.nonce) };
}

/**
 * `itemId` is passed separately because it comes from the *envelope*, not the payload.
 * Trusting an id inside the ciphertext would defeat the binding: the decryption has to
 * be attempted against the id the server filed it under.
 */
export async function decodeItem(
  wire: ItemWire,
  vaultKey: Uint8Array,
  itemId: string,
): Promise<VaultItem> {
  const plaintext = await decryptItem(
    { ct: fromBase64Url(wire.ciphertext), nonce: fromBase64Url(wire.nonce) },
    vaultKey,
    itemId,
  );
  const parsed: unknown = JSON.parse(utf8Decode(plaintext));
  return assertItem(parsed, itemId);
}

/**
 * A decrypted payload is authenticated, but it is still data we wrote in an earlier
 * version and may not match today's shape. Validating keeps a malformed entry from
 * rendering as `undefined` throughout the UI.
 */
function assertItem(value: unknown, itemId: string): VaultItem {
  if (typeof value !== 'object' || value === null) {
    throw new Error('vault item is malformed');
  }
  const record = value as Record<string, unknown>;
  const str = (key: string): string => {
    const found = record[key];
    if (typeof found !== 'string') throw new Error(`vault item is missing ${key}`);
    return found;
  };

  // The id inside must agree with the id it was filed under. AEAD already guarantees
  // it, so a mismatch means we wrote it wrong, not that someone tampered.
  if (str('id') !== itemId) throw new Error('vault item id does not match its envelope');

  const updatedAt = record.updatedAt;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    throw new Error('vault item is missing updatedAt');
  }

  if (record.kind === 'login') {
    return {
      kind: 'login',
      id: itemId,
      title: str('title'),
      host: str('host'),
      username: str('username'),
      password: str('password'),
      ...(typeof record.notes === 'string' ? { notes: record.notes } : {}),
      updatedAt,
    };
  }
  if (record.kind === 'note') {
    return { kind: 'note', id: itemId, title: str('title'), body: str('body'), updatedAt };
  }
  throw new Error('vault item has an unknown kind');
}
