export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCsv(input: string, maxRows = 5_000): CsvTable {
  const text = input.replace(/^\uFEFF/, '');
  const matrix: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field.trim()); field = ''; }
    else if (char === '\n') {
      row.push(field.trim()); field = '';
      if (row.some((value) => value !== '')) matrix.push(row);
      row = [];
      if (matrix.length > maxRows + 1) throw new Error(`CSV exceeds the ${maxRows.toLocaleString()} row limit`);
    } else if (char !== '\r') field += char;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field');
  row.push(field.trim());
  if (row.some((value) => value !== '')) matrix.push(row);
  if (!matrix.length) throw new Error('CSV is empty');
  if (matrix.length - 1 > maxRows) throw new Error(`CSV exceeds the ${maxRows.toLocaleString()} row limit`);

  const headers = matrix[0]!.map((value) => value.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  if (headers.some((header) => !header)) throw new Error('CSV contains an empty header');
  if (new Set(headers).size !== headers.length) throw new Error('CSV contains duplicate headers');

  const rows = matrix.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ''])));
  return { headers, rows };
}

export function requireHeaders(table: CsvTable, required: string[]): void {
  const missing = required.filter((header) => !table.headers.includes(header));
  if (missing.length) throw new Error(`CSV is missing required column(s): ${missing.join(', ')}`);
}

export function moneyToMinor(value: string): number {
  const normalized = value.replace(/[₦,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) throw new Error(`Invalid monetary amount: ${value}`);
  const [whole, fraction = ''] = normalized.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error(`Amount must be greater than zero: ${value}`);
  return minor;
}

export function validDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ][^\s]+)?/.test(value) || Number.isNaN(new Date(value).valueOf())) {
    throw new Error(`Invalid ${field}: ${value}`);
  }
  return value;
}
