/**
 * GenericCsvParseResult — raw data for the column-mapping wizard step.
 * The service converts this to NormalisedRow[] after applying the user's columnMap.
 */
export interface GenericCsvParseResult {
  headers: string[];
  /** Up to 10 preview rows as raw string arrays (column order matches headers). */
  previewRows: string[][];
  /** All rows as raw string arrays (for commit re-parse). */
  allRows: string[][];
  delimiter: string;
}

function splitLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

/** Try comma, tab, semicolon — pick the one giving the most consistent column count. */
function detectDelimiter(lines: string[]): string {
  const candidates = [',', '\t', ';'];
  let best = ',';
  let bestScore = -1;
  for (const delim of candidates) {
    const counts = lines
      .slice(0, 5)
      .map((l) => splitLine(l, delim).length);
    const consistent = counts.every((c) => c === counts[0] && c > 1);
    if (consistent && (counts[0] ?? 0) > bestScore) {
      bestScore = counts[0] ?? 0;
      best = delim;
    }
  }
  return best;
}

/**
 * Parse any UTF-8 CSV file into raw headers + rows.
 * Used for generic_csv and generic_xls (XLS converted to text rows by caller).
 */
export function parseGenericCsv(buffer: Buffer): GenericCsvParseResult {
  const lines = buffer
    .toString('utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  if (lines.length < 2) {
    return { headers: [], previewRows: [], allRows: [], delimiter: ',' };
  }

  const delimiter = detectDelimiter(lines.slice(0, 6));
  const headers = splitLine(lines[0], delimiter);
  const allRows = lines.slice(1).map((l) => splitLine(l, delimiter));
  const previewRows = allRows.slice(0, 10);

  return { headers, previewRows, allRows, delimiter };
}

/**
 * Apply a user-supplied columnMap to convert a raw row into a NormalisedRow.
 * columnMap: { 'Employee ID': 'deviceUserId', 'Punch Time': 'timestamp', ... }
 * Returns null if required fields (deviceUserId, timestamp) are missing after mapping.
 */
export function applyColumnMap(
  headers: string[],
  row: string[],
  columnMap: Record<string, string>,
): {
  deviceUserId: string;
  timestamp: Date;
  punchType: string;
  verifyMethod: null;
} | null {
  const mapped: Record<string, string> = {};
  for (const [header, field] of Object.entries(columnMap)) {
    const idx = headers.indexOf(header);
    if (idx !== -1) mapped[field] = row[idx] ?? '';
  }

  const deviceUserId = mapped['deviceUserId']?.trim() ?? '';
  const timestampStr = mapped['timestamp']?.trim() ?? '';
  if (!deviceUserId || !timestampStr) return null;

  const timestamp = new Date(timestampStr);
  if (isNaN(timestamp.getTime())) return null;

  const rawPunch = (mapped['punchType'] ?? '').toLowerCase();
  const punchType =
    rawPunch === 'out' || rawPunch === '1' || rawPunch === 'check_out'
      ? 'CHECK_OUT'
      : 'CHECK_IN';

  return { deviceUserId, timestamp, punchType, verifyMethod: null };
}
