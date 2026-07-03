/**
 * NormalisedRow — the common shape produced by all four format parsers.
 * Downstream: AttendanceImportService maps these to AttendanceEvent documents.
 */
export interface NormalisedRow {
  /** Device-side user identifier (PIN from ZK, Emp Code from eTimeTrack, Person ID from BioTime). */
  deviceUserId: string;
  /** Punch moment. Stored as-is (device local time = IST for India, same convention as ingest path). */
  timestamp: Date;
  /** One of: CHECK_IN | CHECK_OUT | BREAK_OUT | BREAK_IN | OT_IN | OT_OUT */
  punchType: string;
  /** Verify method if available, null otherwise. */
  verifyMethod: string | null;
}

/** Supported format identifiers. */
export type ImportFileFormat =
  | 'zk_dat'
  | 'etimetrack_xls'
  | 'biotime_csv'
  | 'generic_csv'
  | 'generic_xls';

/** Column map: detected file header → our canonical field name. */
export type ColumnMap = Record<string, string>;

/** Result of the format-detection step. */
export interface DetectionResult {
  format: ImportFileFormat;
  /** First ≤10 normalised rows for the preview step. */
  preview: NormalisedRow[];
  /** Inferred column map (populated for auto-mapped formats; empty for generic). */
  columnMap: ColumnMap;
  /** Raw column headers from the file (for the column-mapping wizard step). */
  headers: string[];
  /** All unique deviceUserId values found in the parsed rows. */
  deviceUserIds: string[];
}
