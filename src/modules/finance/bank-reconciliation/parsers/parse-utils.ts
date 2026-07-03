import { BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';

// ---------------------------------------------------------------------------
// BOM stripping
// ---------------------------------------------------------------------------

/**
 * Remove the UTF-8 BOM character (U+FEFF) from the start of a string.
 * HDFC CSV downloads carry a leading BOM that breaks header signature matching
 * if not stripped first (Pitfall 3).
 */
export function stripBom(s: string): string {
  return s.replace(/^﻿/, '');
}

// ---------------------------------------------------------------------------
// Amount parsing — all amounts stored as integer paise, never float
// ---------------------------------------------------------------------------

/**
 * Convert an Indian-format amount string (or raw number from xlsx) to integer paise.
 *
 * Handles:
 * - Indian lakh comma format: "12,45,000.50" → 124500050 (Pitfall 2)
 * - Rupee symbol: "₹12,450" → 1245000
 * - INR prefix/suffix: "INR 12450" → 1245000
 * - xlsx numeric cells: 12450.5 → 1245050
 * - Empty / dash / null → 0 (no-amount cells common in split-column CSVs)
 *
 * Uses Math.round() to prevent IEEE 754 floating-point drift (Pitfall 1).
 */
export function parsePaise(raw: string | number | null | undefined): number {
  if (raw == null || raw === '' || raw === '-') return 0;

  if (typeof raw === 'number') {
    return Math.round(raw * 100);
  }

  const cleaned = String(raw)
    .replace(/[,\s₹]/g, '')
    .replace(/INR/gi, '')
    .trim();

  if (!cleaned || cleaned === '-') return 0;

  const f = parseFloat(cleaned);
  if (isNaN(f)) {
    throw new Error('Cannot parse amount: ' + JSON.stringify(raw));
  }
  return Math.round(f * 100);
}

// ---------------------------------------------------------------------------
// Date parsing — UTC midnight construction to avoid timezone skew (Pitfall 8)
// ---------------------------------------------------------------------------

const MONTH_ABBR: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse an Indian bank statement date string (or xlsx serial number) to a UTC Date.
 *
 * Supported patterns (in priority order):
 *   DD/MM/YYYY       — HDFC, ICICI, Kotak, IndusInd, PNB, BOB, YES Bank
 *   DD-MM-YYYY       — ICICI variant, Axis
 *   DD/MM/YY         — HDFC older format (year ≤50 → 20XX, else 19XX)
 *   D MMM YYYY       — SBI: "1 Apr 2025"
 *   DD MMM YYYY      — SBI: "01 Apr 2025"
 *   YYYY-MM-DD       — ISO 8601 fallback
 *
 * Always constructs via Date.UTC() — UTC midnight, no local timezone offset (Pitfall 8).
 */
export function parseDate(raw: string | number | null | undefined): Date {
  if (raw == null || raw === '') {
    throw new Error('Cannot parse date: ' + JSON.stringify(raw));
  }

  // xlsx numeric serial date (Excel epoch: 1899-12-30)
  if (typeof raw === 'number') {
    // Honour Lotus 1-2-3 leap-year bug: epoch is 1899-12-30
    const ms = Date.UTC(1899, 11, 30 + Math.floor(raw));
    return new Date(ms);
  }

  const s = String(raw).trim();

  // DD/MM/YYYY
  const dmY4 = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (dmY4) {
    const [, d, m, y] = dmY4;
    return new Date(Date.UTC(+y, +m - 1, +d));
  }

  // DD-MM-YYYY
  const dmY4dash = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  if (dmY4dash) {
    const [, d, m, y] = dmY4dash;
    return new Date(Date.UTC(+y, +m - 1, +d));
  }

  // DD/MM/YY
  const dmY2 = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(s);
  if (dmY2) {
    const [, d, m, y] = dmY2;
    const fullYear = +y <= 50 ? 2000 + +y : 1900 + +y;
    return new Date(Date.UTC(fullYear, +m - 1, +d));
  }

  // D MMM YYYY or DD MMM YYYY — e.g. "1 Apr 2025", "01 Apr 2025"
  const dMmmY = /^(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})$/i.exec(s);
  if (dMmmY) {
    const [, d, mon, y] = dMmmY;
    const m = MONTH_ABBR[mon.toLowerCase()];
    return new Date(Date.UTC(+y, m - 1, +d));
  }

  // YYYY-MM-DD (ISO)
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    return new Date(Date.UTC(+y, +m - 1, +d));
  }

  throw new Error('Cannot parse date: ' + JSON.stringify(raw));
}

// ---------------------------------------------------------------------------
// CSV injection prevention (OWASP)
// ---------------------------------------------------------------------------

/**
 * Strip leading formula-injection characters from a cell value.
 * Applies the OWASP CSV Injection control:
 *   https://owasp.org/www-community/attacks/CSV_Injection
 *
 * Characters stripped: =, +, -, @, tab (0x09), carriage return (0x0D)
 * Threat T-13-W2-02.
 */
export function stripCsvFormulaPrefix(s: string): string {
  return (s ?? '').replace(/^[=+\-@\t\r]+/, '');
}

// ---------------------------------------------------------------------------
// Reference normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a bank reference / UTR number for fuzzy matching.
 * Strips UPI/NEFT/IMPS/RTGS/CMS/INF/MPS/NFS prefixes, lowercases,
 * removes spaces and hyphens, and extracts the last 12 digits for
 * UTR pattern references (format: XXXX + 12 digits).
 */
export function normaliseRef(raw: string | undefined): string {
  if (!raw) return '';
  let s = raw.toLowerCase().replace(/[\s\-]/g, '');
  // Strip known payment network prefixes (with and without slash separator)
  s = s.replace(/^(upi|neft|imps|rtgs|cms|inf|mps|nfs)\//, '');
  s = s.replace(/^(upi|neft|imps|rtgs|cms|inf|mps|nfs)/, '');
  // Extract last 12 digits if UTR pattern: 4 letters + 12 digits
  if (/[a-z]{4}\d{12}$/.test(s)) {
    const match = s.match(/\d{12}$/);
    if (match) return match[0];
  }
  return s;
}

// ---------------------------------------------------------------------------
// Narration normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a narration string for matching: strip formula prefix, lowercase,
 * collapse whitespace, trim.
 */
export function normaliseNarration(raw: string): string {
  return stripCsvFormulaPrefix(raw ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Levenshtein distance — Wagner-Fischer DP (RESEARCH §12.3)
// ---------------------------------------------------------------------------

/**
 * Compute the Levenshtein edit distance between two strings.
 * Used by the matching engine to score reference number similarity.
 * Short-string only — no external library needed.
 */
export function levenshtein(a: string, b: string): number {
  // Guard against O(m×n) memory blow-up on long narration strings.
  // Bank narrations beyond 64 chars add no meaningful signal for reference matching.
  const MAX_LEN = 64;
  if (a.length > MAX_LEN) a = a.slice(0, MAX_LEN);
  if (b.length > MAX_LEN) b = b.slice(0, MAX_LEN);
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

// ---------------------------------------------------------------------------
// CSV / buffer utilities
// ---------------------------------------------------------------------------

/**
 * Tokenise a single CSV line respecting double-quoted fields.
 * Handles escaped quotes (""), trims surrounding whitespace from unquoted cells.
 */
function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped double-quote inside a quoted field
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
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
 * Parse a CSV buffer into a 2-D string array.
 * Strips BOM, splits on line endings, tokenises each non-empty line.
 * Returns string[][] where each inner array is one row's cells.
 */
export function bufferToCsvLines(buffer: Buffer): string[][] {
  const text = stripBom(buffer.toString('utf8'));
  const lines = text.split(/\r?\n/);
  const result: string[][] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    result.push(splitCsvLine(line));
  }
  return result;
}

// ---------------------------------------------------------------------------
// XLSX / XLS utilities
// ---------------------------------------------------------------------------

/**
 * Read an XLS or XLSX buffer and return all rows from the first sheet as
 * an unknown[][] (cell values may be string, number, Date, boolean, null).
 *
 * Uses cellDates:false so dates come back as Excel serial numbers — parseDate
 * handles those via the numeric branch (Excel epoch 1899-12-30).
 */
export function readXlsxAsRows(buffer: Buffer): unknown[][] {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
  }) as unknown[][];
}

// ---------------------------------------------------------------------------
// File type detection
// ---------------------------------------------------------------------------

/**
 * Determine whether a file is CSV, XLS, or XLSX by extension.
 * Throws BadRequestException for unsupported extensions so the
 * file upload endpoint returns a clean 400 error.
 */
export function detectFileType(
  originalFilename: string,
): 'csv' | 'xls' | 'xlsx' {
  const ext = originalFilename.toLowerCase().split('.').pop() ?? '';
  if (ext === 'csv') return 'csv';
  if (ext === 'xls') return 'xls';
  if (ext === 'xlsx') return 'xlsx';
  throw new BadRequestException('Unsupported extension: ' + ext);
}
