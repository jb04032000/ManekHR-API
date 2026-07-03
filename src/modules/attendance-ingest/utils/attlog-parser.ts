import type { AttlogRecord } from '../dto/attlog-record.dto';

/**
 * Parse a raw ATTLOG body (text/plain, tab-separated, \n or \r\n delimited).
 * ATTLOG field order: PIN \t DateTime \t Status \t Verify \t WorkCode \t Reserved...
 * Source: ZKTeco PUSH SDK Protocol v2.0.1 + B-RESEARCH.md Pattern 2
 */
export function parseAttlog(rawBody: string): AttlogRecord[] {
  if (!rawBody || !rawBody.trim()) return [];
  return rawBody
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parts = line.split('\t');
      const [pin, datetime, status, verify] = parts;
      return {
        deviceUserId: (pin ?? '').trim(),
        timestamp: new Date(datetime ?? ''),
        statusCode: parseInt(status ?? '0', 10),
        verifyCode: parseInt(verify ?? '0', 10),
      };
    })
    .filter((r) => r.deviceUserId && !isNaN(r.timestamp.getTime()));
}
