import { BadRequestException } from '@nestjs/common';
import { DetectionResult, ImportFileFormat, NormalisedRow } from './normalised-row';
import { isZkDat, parseZkDat } from './zk-dat';
import { isETimeTrack, parseETimeTrackXls } from './etimetrack-xls';
import { isBioTimeCsv, parseBioTimeCsv } from './biotime-csv';
import { parseGenericCsv } from './generic-csv';
import * as XLSX from 'xlsx';

const SUPPORTED_FORMATS = '.dat, .xls, .xlsx, .csv, .txt';

/**
 * Detect file format, parse rows, and return DetectionResult.
 * Called by AttendanceImportService for both parse and commit requests.
 *
 * Detection order (important — do not reorder):
 *   1. ZK .dat (checked before CSV to avoid false positives)
 *   2. eTimeTrackLite XLS/XLSX
 *   3. BioTime CSV (checked before generic to use known headers)
 *   4. Generic CSV / TXT
 *   5. Generic XLS (XLS that did not match eTimeTrack)
 *   6. Unknown → BadRequestException
 */
export function detectAndParse(
  buffer: Buffer,
  originalName: string,
): DetectionResult {
  // 1. ZK .dat
  if (isZkDat(buffer, originalName)) {
    const rows = parseZkDat(buffer);
    return buildResult('zk_dat', rows, [], {});
  }

  // 2. eTimeTrackLite XLS/XLSX
  if (isETimeTrack(buffer, originalName)) {
    const rows = parseETimeTrackXls(buffer);
    const inferredMap: Record<string, string> = {
      'Emp Code': 'deviceUserId',
      Date: 'date',
      'In Time': 'inTime',
      'Out Time': 'outTime',
    };
    return buildResult('etimetrack_xls', rows, [], inferredMap);
  }

  const ext = originalName.toLowerCase();

  // 3. BioTime CSV
  if (isBioTimeCsv(buffer, originalName)) {
    const rows = parseBioTimeCsv(buffer);
    const inferredMap: Record<string, string> = {
      'Person ID': 'deviceUserId',
      Time: 'timestamp',
      Status: 'punchType',
    };
    return buildResult(
      'biotime_csv',
      rows,
      ['Person ID', 'Name', 'Department', 'Time', 'Device Alias', 'Status'],
      inferredMap,
    );
  }

  // 4. Generic CSV / TXT
  if (ext.endsWith('.csv') || ext.endsWith('.txt')) {
    const { headers } = parseGenericCsv(buffer);
    // Return empty rows — column mapping wizard builds them from user's columnMap.
    return {
      format: 'generic_csv',
      preview: [],
      columnMap: {},
      headers,
      deviceUserIds: [],
    };
  }

  // 5. Generic XLS (not matched as eTimeTrack)
  if (ext.endsWith('.xls') || ext.endsWith('.xlsx')) {
    try {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const headerRow =
        XLSX.utils.sheet_to_json<string[]>(sheet, {
          header: 1,
          raw: false,
        })[0] ?? [];
      const headers = headerRow.map(String);
      return {
        format: 'generic_xls',
        preview: [],
        columnMap: {},
        headers,
        deviceUserIds: [],
      };
    } catch {
      throw new BadRequestException(
        `Cannot read XLS file. Supported formats: ${SUPPORTED_FORMATS}`,
      );
    }
  }

  throw new BadRequestException(
    `Unsupported file format. Supported formats: ${SUPPORTED_FORMATS}`,
  );
}

function buildResult(
  format: ImportFileFormat,
  rows: NormalisedRow[],
  headers: string[],
  columnMap: Record<string, string>,
): DetectionResult {
  const deviceUserIds = [...new Set(rows.map((r) => r.deviceUserId))];
  return {
    format,
    preview: rows.slice(0, 10),
    columnMap,
    headers,
    deviceUserIds,
  };
}
