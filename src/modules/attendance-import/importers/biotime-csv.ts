import { NormalisedRow } from './normalised-row';

const BIOTIME_STATUS_MAP: Record<string, string> = {
  in: 'CHECK_IN',
  out: 'CHECK_OUT',
  'check in': 'CHECK_IN',
  'check out': 'CHECK_OUT',
};

function parseCsvLine(line: string): string[] {
  // Simple RFC-4180 split; handles quoted fields with commas.
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Detect: .csv or .txt extension AND row-0 headers contain 'Person ID' and 'Device Alias'
 * (case-insensitive).
 */
export function isBioTimeCsv(buffer: Buffer, originalName: string): boolean {
  const ext = originalName.toLowerCase();
  if (!ext.endsWith('.csv') && !ext.endsWith('.txt')) return false;
  const firstLine = buffer.toString('utf8', 0, 512).split(/\r?\n/)[0] ?? '';
  const headers = firstLine
    .toLowerCase()
    .split(',')
    .map((h) => h.trim().replace(/^"|"$/g, ''));
  return headers.includes('person id') && headers.includes('device alias');
}

/**
 * Parse BioTime CSV buffer.
 * Expected headers: Person ID, Name, Department, Time, Device Alias, Status
 */
export function parseBioTimeCsv(buffer: Buffer): NormalisedRow[] {
  const lines = buffer
    .toString('utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const personIdIdx = headers.indexOf('person id');
  const timeIdx = headers.indexOf('time');
  const statusIdx = headers.indexOf('status');

  if (personIdIdx === -1 || timeIdx === -1 || statusIdx === -1) return [];

  const results: NormalisedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const personId = cols[personIdIdx]?.trim() ?? '';
    const timeStr = cols[timeIdx]?.trim() ?? '';
    const statusRaw = (cols[statusIdx]?.trim() ?? '').toLowerCase();

    if (!personId || !timeStr) continue;

    const ts = new Date(timeStr);
    if (isNaN(ts.getTime())) continue;

    const punchType = BIOTIME_STATUS_MAP[statusRaw] ?? 'CHECK_IN';
    results.push({ deviceUserId: personId, timestamp: ts, punchType, verifyMethod: null });
  }

  return results;
}
