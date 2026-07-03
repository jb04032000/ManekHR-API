import { IsObject, IsOptional, IsBoolean, IsString } from 'class-validator';

/**
 * CommitRequestDto — deserialized from the 'data' form field on the commit request.
 * The frontend sends: form.append('data', JSON.stringify(payload)).
 * The controller validates it via plainToInstance + validateSync (class-validator).
 */
export class CommitRequestDto {
  /**
   * Column map from detected/user-set header → canonical field name.
   * Required for generic_csv / generic_xls. Empty for auto-detected formats.
   * Example: { 'Employee ID': 'deviceUserId', 'Punch Time': 'timestamp' }
   */
  @IsObject()
  columnMap: Record<string, string>;

  /**
   * Member map: deviceUserId → teamMemberId (ObjectId string) | null (leave unassigned).
   * Example: { '1001': '6634aab2...', '1002': null }
   */
  @IsObject()
  memberMap: Record<string, string | null>;

  /**
   * Optional device serial to attach to all imported events.
   * When provided, events use existing biometric partial-index dedupe (deviceSerial is set).
   * When null, importHash-based dedupe applies.
   */
  @IsOptional()
  @IsString()
  deviceSerial?: string | null;

  /**
   * When true: compute importHash + count would-insert vs would-skip but do NOT write.
   * Returns { inserted: 0, skipped: N, willInsert: M, errors: [] }.
   */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export interface CommitResult {
  inserted: number;
  skipped: number;
  /** Populated for dryRun=true: how many rows would be inserted on real commit. */
  willInsert?: number;
  errors: string[];
}
