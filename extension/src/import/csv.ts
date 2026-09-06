/**
 * A CSV reader, hand-rolled, because the naive version loses data silently.
 *
 * `line.split(',')` corrupts any field containing a comma — and a password is exactly
 * the kind of field that contains one. The row still parses, the import still reports
 * success, and the user finds out when a site rejects a password they can no longer
 * recover. That is the worst shape a bug can take in an importer, so this follows
 * RFC 4180 properly: quoted fields, `""` as an escaped quote, and newlines inside
 * quotes.
 */

/** Splits a CSV document into rows of fields. Blank trailing lines are ignored. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  const endField = () => {
    row.push(field);
    field = '';
    started = false;
  };
  const endRow = () => {
    endField();
    // A row of one empty field is a blank line, not a record.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;

    if (quoted) {
      if (ch !== '"') {
        field += ch;
        continue;
      }
      // `""` inside a quoted field is one literal quote.
      if (input[i + 1] === '"') {
        field += '"';
        i += 1;
        continue;
      }
      quoted = false;
      continue;
    }

    if (ch === '"' && !started) {
      quoted = true;
      started = true;
      continue;
    }
    if (ch === ',') {
      endField();
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      endRow();
      continue;
    }
    field += ch;
    started = true;
  }

  // A file that does not end in a newline still has a final row.
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}

/**
 * Rows as records, keyed by the header.
 *
 * Header names are lower-cased and trimmed: exports differ on capitalisation between
 * Chrome versions, and failing an import over `Name` versus `name` would be absurd.
 */
export function parseCsvRecords(input: string): Array<Record<string, string>> {
  const rows = parseCsv(input);
  const header = rows[0];
  if (header === undefined) return [];

  const keys = header.map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    keys.forEach((key, i) => {
      record[key] = row[i] ?? '';
    });
    return record;
  });
}
