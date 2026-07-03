import { detectHdfc } from './hdfc.parser';
import { detectIcici } from './icici.parser';
import { detectSbi } from './sbi.parser';
import { detectAxis } from './axis.parser';
import { detectKotak } from './kotak.parser';
import { detectYesBank } from './yes-bank.parser';
import { detectIndusind } from './indusind.parser';
import { detectPnb } from './pnb.parser';
import { detectBob } from './bob.parser';

import type { BankFormatKey } from './normalised-row';
import { bufferToCsvLines, readXlsxAsRows, detectFileType } from './parse-utils';

/**
 * Try each bank's detect() against every header-shaped row in the file,
 * up to the first 12 rows (handles SBI/Axis metadata rows before the header).
 * Returns the canonical bank key, or 'generic' if no match found.
 *
 * Detection order follows market share:
 *   HDFC → ICICI → SBI → Axis → Kotak → YES Bank → IndusInd → PNB → BOB → generic
 */
export function detectBankFormat(buffer: Buffer, filename: string): BankFormatKey {
  const fileType = detectFileType(filename);
  const rows: unknown[][] =
    fileType === 'csv'
      ? (bufferToCsvLines(buffer) as unknown[][])
      : readXlsxAsRows(buffer);

  const scanLimit = Math.min(12, rows.length);
  for (let i = 0; i < scanLimit; i++) {
    const headers = (rows[i] ?? []).map((c) => String(c ?? '').trim());
    if (detectHdfc(headers)) return 'hdfc';
    if (detectIcici(headers)) return 'icici';
    if (detectSbi(headers)) return 'sbi';
    if (detectAxis(headers)) return 'axis';
    if (detectKotak(headers)) return 'kotak';
    if (detectYesBank(headers)) return 'yes_bank';
    if (detectIndusind(headers)) return 'indusind';
    if (detectPnb(headers)) return 'pnb';
    if (detectBob(headers)) return 'bob';
  }

  return 'generic';
}
