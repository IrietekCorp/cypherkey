import { describe, expect, test } from 'bun:test';
import { parseBitwarden } from './bitwarden';
import { hostFromUrl, parseChromeCsv } from './chrome-csv';
import { parseCsv, parseCsvRecords } from './csv';

let counter = 0;
const deps = { newId: () => `id-${++counter}`, now: () => 1_788_000_000_000 };

describe('the CSV reader', () => {
  test('plain rows', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  /**
   * The bug this exists to prevent: `split(',')` corrupts any field with a comma, and
   * a password is exactly that kind of field. The row still parses, the import still
   * reports success, and the user finds out when a site rejects a password they can no
   * longer recover.
   */
  test('a quoted field may contain commas', () => {
    const [, row] = parseCsv('name,password\nBank,"a,b,c"\n');
    expect(row).toEqual(['Bank', 'a,b,c']);
  });

  test('a doubled quote is one literal quote', () => {
    const [, row] = parseCsv('name,password\nBank,"say ""hi"""\n');
    expect(row).toEqual(['Bank', 'say "hi"']);
  });

  test('a quoted field may contain a newline', () => {
    const rows = parseCsv('name,note\nWifi,"line one\nline two"\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.[1]).toBe('line one\nline two');
  });

  test('a file with no trailing newline keeps its last row', () => {
    expect(parseCsv('a,b\n1,2')).toHaveLength(2);
  });

  test('CRLF line endings are handled', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  test('blank lines are not records', () => {
    expect(parseCsv('a,b\n\n1,2\n\n')).toHaveLength(2);
  });

  test('empty fields survive as empty strings', () => {
    expect(parseCsv('a,b,c\n1,,3\n')[1]).toEqual(['1', '', '3']);
  });

  test('records are keyed by a case-insensitive header', () => {
    const records = parseCsvRecords('Name,URL\nGitHub,https://github.com\n');
    expect(records[0]).toEqual({ name: 'GitHub', url: 'https://github.com' });
  });

  test('a header-only file yields no records', () => {
    expect(parseCsvRecords('name,url\n')).toEqual([]);
  });

  test('an empty file yields no records', () => {
    expect(parseCsvRecords('')).toEqual([]);
  });
});

describe('hostFromUrl', () => {
  test.each([
    ['https://github.com/login', 'github.com'],
    ['http://example.com', 'example.com'],
    ['github.com', 'github.com'],
    ['https://sub.example.co.uk/path?q=1', 'sub.example.co.uk'],
    ['', ''],
  ])('%s becomes %s', (raw, expected) => {
    expect(hostFromUrl(raw)).toBe(expected);
  });

  test('an unparseable value degrades rather than throwing', () => {
    expect(() => hostFromUrl('android://com.example')).not.toThrow();
  });
});

describe('Chrome CSV', () => {
  const CSV = [
    'name,url,username,password,note',
    'GitHub,https://github.com/,shawn,hunter2,',
    'Bank,https://bank.example/,shawn,"a,b,c",a note',
    ',https://noname.example/,x,pw,',
    'NoPassword,https://nopw.example/,x,,',
    // Has a password but nothing to call it by: reaches the name check, which the
    // all-empty row below never does because the password check fires first.
    ',,x,orphan-pw,',
    ',,,,',
  ].join('\n');

  test('rows become login items', () => {
    const result = parseChromeCsv(CSV, deps);
    const github = result.items.find((i) => i.title === 'GitHub');
    expect(github?.kind).toBe('login');
    expect(github?.kind === 'login' ? github.host : null).toBe('github.com');
    expect(github?.kind === 'login' ? github.username : null).toBe('shawn');
  });

  test('a password containing commas survives intact', () => {
    const bank = parseChromeCsv(CSV, deps).items.find((i) => i.title === 'Bank');
    expect(bank?.kind === 'login' ? bank.password : null).toBe('a,b,c');
  });

  test('a row with no name falls back to its host', () => {
    const result = parseChromeCsv(CSV, deps);
    expect(result.items.some((i) => i.title === 'noname.example')).toBe(true);
  });

  /** A skipped row must say why, or the user cannot tell what they lost. */
  test('a row with no password is skipped with a reason', () => {
    const result = parseChromeCsv(CSV, deps);
    const reason = result.skipped.map((s) => s.reason).join(' ');
    expect(reason).toContain('no password');
  });

  test('a row with nothing to identify it is skipped with a reason', () => {
    const result = parseChromeCsv(CSV, deps);
    expect(result.skipped.some((s) => s.reason.includes('no name or address'))).toBe(true);
  });

  /** The number the user is shown has to add up. */
  test('imported plus skipped equals the rows seen', () => {
    const result = parseChromeCsv(CSV, deps);
    expect(result.items.length + result.skipped.length).toBe(result.total);
  });

  test('a bad row does not abort the batch', () => {
    const result = parseChromeCsv(CSV, deps);
    expect(result.items.length).toBeGreaterThan(1);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  test('skipped rows carry a spreadsheet row number, counting the header', () => {
    const result = parseChromeCsv(CSV, deps);
    for (const entry of result.skipped) expect(entry.row).toBeGreaterThanOrEqual(2);
  });

  test('a password is never trimmed', () => {
    const csv = 'name,url,username,password,note\nX,https://x.example/,u,"  spaced  ",';
    const [item] = parseChromeCsv(csv, deps).items;
    expect(item?.kind === 'login' ? item.password : null).toBe('  spaced  ');
  });
});

describe('Bitwarden JSON', () => {
  const EXPORT = JSON.stringify({
    encrypted: false,
    items: [
      {
        type: 1,
        name: 'GitHub',
        notes: 'the one with the yubikey',
        login: { username: 'shawn', password: 'hunter2', uris: [{ uri: 'https://github.com' }] },
      },
      { type: 2, name: 'Wifi', notes: 'upstairs: swordfish' },
      { type: 3, name: 'Visa', notes: null },
      { type: 1, name: 'NoPassword', login: { username: 'x', password: '', uris: [] } },
      { type: 1, name: '', login: { username: 'x', password: 'y' } },
    ],
  });

  test('logins and notes both convert', () => {
    const result = parseBitwarden(EXPORT, deps);
    expect(result.items.find((i) => i.title === 'GitHub')?.kind).toBe('login');
    expect(result.items.find((i) => i.title === 'Wifi')?.kind).toBe('note');
  });

  test('a login keeps its host, username and notes', () => {
    const item = parseBitwarden(EXPORT, deps).items.find((i) => i.title === 'GitHub');
    expect(item?.kind === 'login' ? item.host : null).toBe('github.com');
    expect(item?.kind === 'login' ? item.notes : null).toContain('yubikey');
  });

  /**
   * A card has nowhere to go here. Reshaping it into a login would lose the number and
   * present it as something it is not; saying what was left behind is the honest thing.
   */
  test('a card is skipped by name, saying what it was', () => {
    const result = parseBitwarden(EXPORT, deps);
    const reason = result.skipped.find((s) => s.reason.includes('Visa'))?.reason ?? '';
    expect(reason).toContain('card');
    expect(reason).toContain('cannot hold yet');
  });

  test('a login with no password is skipped by name', () => {
    const result = parseBitwarden(EXPORT, deps);
    expect(result.skipped.some((s) => s.reason.includes('NoPassword'))).toBe(true);
  });

  test('an item with no name is skipped', () => {
    const result = parseBitwarden(EXPORT, deps);
    expect(result.skipped.some((s) => s.reason === 'no name')).toBe(true);
  });

  test('imported plus skipped equals the items seen', () => {
    const result = parseBitwarden(EXPORT, deps);
    expect(result.items.length + result.skipped.length).toBe(result.total);
  });

  /** A whole-file problem is said once, not reported as every row being broken. */
  test('invalid JSON is one clear error', () => {
    expect(() => parseBitwarden('{not json', deps)).toThrow('not valid JSON');
  });

  test('an encrypted export says what to do instead', () => {
    const encrypted = JSON.stringify({ encrypted: true, items: [] });
    expect(() => parseBitwarden(encrypted, deps)).toThrow('export unencrypted JSON');
  });

  test('a file with no items array is refused', () => {
    expect(() => parseBitwarden('{"foo":1}', deps)).toThrow('no items');
  });

  test('an empty export is not an error', () => {
    const result = parseBitwarden(JSON.stringify({ items: [] }), deps);
    expect(result).toEqual({ items: [], skipped: [], total: 0 });
  });
});

describe('what an importer must not do', () => {
  /** The file is read into memory and mapped; nothing writes it anywhere. */
  test('neither parser writes to disk', async () => {
    for (const file of ['bitwarden.ts', 'chrome-csv.ts', 'csv.ts']) {
      const source = await Bun.file(`${import.meta.dir}/${file}`).text();
      expect(source).not.toContain('Bun.write');
      expect(source).not.toContain('localStorage');
      expect(source).not.toContain('console.');
    }
  });

  test('a skipped reason never quotes the password itself', () => {
    const csv = 'name,url,username,password,note\n,https://x.example/,u,supersecret,';
    const result = parseChromeCsv(csv, deps);
    const reasons = JSON.stringify(result.skipped);
    expect(reasons).not.toContain('supersecret');
  });
});
