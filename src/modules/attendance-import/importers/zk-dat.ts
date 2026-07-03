import { parseAttlog } from '../../attendance-ingest/utils/attlog-parser';
import {
  mapStatusCode,
  mapVerifyCode,
} from '../../attendance-ingest/utils/zk-code-mapper';
import { NormalisedRow } from './normalised-row';

/**
 * Parse a ZK .dat (attlog.dat) buffer.
 * Format: tab-separated text, field order: PIN \t DateTime \t Status \t Verify \t ...
 * Reuses parseAttlog() from attendance-ingest — no duplication.
 */
export function parseZkDat(buffer: Buffer): NormalisedRow[] {
  const text = buffer.toString('utf8');
  return parseAttlog(text).map((r) => ({
    deviceUserId: r.deviceUserId,
    timestamp: r.timestamp,
    punchType: mapStatusCode(r.statusCode),
    verifyMethod: mapVerifyCode(r.verifyCode),
  }));
}

/**
 * Detect heuristic: file extension is .dat AND first non-empty line matches
 * /^\d+\t\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\t\d/
 */
export function isZkDat(buffer: Buffer, originalName: string): boolean {
  if (!originalName.toLowerCase().endsWith('.dat')) return false;
  const firstLine = buffer.toString('utf8', 0, 200).split(/\r?\n/)[0] ?? '';
  return /^\d+\t\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\t\d/.test(firstLine);
}
