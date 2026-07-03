import { ImportFileFormat } from '../importers/normalised-row';

/**
 * Response shape for POST .../import/parse.
 * Serialized by NestJS ResponseInterceptor into { success: true, data: {...} }.
 */
export class ParseResponseDto {
  /** Detected format identifier. */
  format: ImportFileFormat;

  /** Up to 10 preview rows. Each row is { deviceUserId, timestamp (ISO), punchType, verifyMethod }. */
  preview: Array<{
    deviceUserId: string;
    timestamp: string;
    punchType: string;
    verifyMethod: string | null;
  }>;

  /**
   * Inferred column map for auto-detected formats.
   * Empty object for generic_csv / generic_xls — user must map in step 3.
   * Record<detectedHeader, canonicalFieldName>
   */
  columnMap: Record<string, string>;

  /** Raw column headers from the file (for the column-mapping wizard step). */
  headers: string[];

  /**
   * Unique device user IDs found in the file (for the member-mapping wizard step 5).
   * Empty array for generic formats until user applies columnMap.
   */
  deviceUserIds: string[];
}
