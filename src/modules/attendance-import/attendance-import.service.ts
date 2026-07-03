import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as crypto from 'crypto';
import { detectAndParse } from './importers/format-detector';
import { parseGenericCsv, applyColumnMap } from './importers/generic-csv';
import { parseZkDat, isZkDat } from './importers/zk-dat';
import { parseETimeTrackXls, isETimeTrack } from './importers/etimetrack-xls';
import { parseBioTimeCsv, isBioTimeCsv } from './importers/biotime-csv';
import { NormalisedRow } from './importers/normalised-row';
import { ParseResponseDto } from './dto/parse-response.dto';
import { CommitRequestDto, CommitResult } from './dto/commit-request.dto';
import { AttendanceEvent } from '../attendance/schemas/attendance-event.schema';
import { AttendanceProjectionService } from '../attendance/attendance-projection.service';
import { Salary } from '../salary/schemas/salary.schema';
import * as XLSX from 'xlsx';

@Injectable()
export class AttendanceImportService {
  private readonly logger = new Logger(AttendanceImportService.name);

  constructor(
    @InjectModel(AttendanceEvent.name)
    private readonly eventModel: Model<AttendanceEvent>,
    @InjectModel(Salary.name)
    private readonly salaryModel: Model<Salary>,
    private readonly projectionService: AttendanceProjectionService,
  ) {}

  /** Detect file format, parse rows, return preview + column map. */
  detectAndPreview(file: Express.Multer.File): ParseResponseDto {
    if (!file?.buffer) {
      throw new BadRequestException('File buffer is empty');
    }
    const result = detectAndParse(file.buffer, file.originalname);
    const preview = result.preview.map((r) => ({
      deviceUserId: r.deviceUserId,
      timestamp: r.timestamp.toISOString(),
      punchType: r.punchType,
      verifyMethod: r.verifyMethod,
    }));
    return {
      format: result.format,
      preview,
      columnMap: result.columnMap,
      headers: result.headers,
      deviceUserIds: result.deviceUserIds,
    };
  }

  /**
   * Re-parse file, apply maps, compute importHash, batch-insert events.
   * When dryRun=true: count inserts/skips without writing to DB.
   */
  async commitImport(
    wsId: string,
    file: Express.Multer.File,
    dto: CommitRequestDto,
    uploadedByUserId: string,
  ): Promise<CommitResult> {
    if (!file?.buffer) {
      throw new BadRequestException('File buffer is empty');
    }

    // Re-parse the file from scratch (stateless design — no server session).
    // _parseAllRows returns both rows and the detected format string so we
    // avoid a second detectAndParse() call just for sourceMeta.
    const { rows, format: detectedFormat } = this._parseAllRows(
      file.buffer,
      file.originalname,
      dto.columnMap,
    );

    const wsObjectId = new Types.ObjectId(wsId);
    const now = new Date();
    const errors: string[] = [];

    // Build event documents.
    const eventDocs: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const teamMemberIdStr = dto.memberMap[row.deviceUserId] ?? null;
      let teamMemberId: Types.ObjectId | null = null;
      if (teamMemberIdStr) {
        if (!Types.ObjectId.isValid(teamMemberIdStr)) {
          errors.push(
            `Invalid teamMemberId for deviceUserId "${row.deviceUserId}": "${teamMemberIdStr}"`,
          );
          continue;
        }
        teamMemberId = new Types.ObjectId(teamMemberIdStr);
      }

      const importHash = computeImportHash(
        wsId,
        teamMemberIdStr,
        row.deviceUserId,
        row.timestamp,
        row.punchType,
      );

      // markedBy: only set if uploadedByUserId is a valid ObjectId
      let markedBy: Types.ObjectId | null = null;
      try {
        markedBy = new Types.ObjectId(uploadedByUserId);
      } catch {
        // uploadedByUserId is 'unknown' or non-ObjectId — leave null
      }

      eventDocs.push({
        wsId: wsObjectId,
        teamMemberId,
        deviceSerial: dto.deviceSerial ?? null,
        deviceUserId: row.deviceUserId,
        timestamp: row.timestamp,
        punchType: row.punchType,
        verifyMethod: row.verifyMethod,
        source: 'file_upload',
        sourceMeta: {
          fileName: file.originalname,
          format: detectedFormat,
          uploadedBy: uploadedByUserId,
          uploadedAt: now.toISOString(),
        },
        markedBy,
        importHash,
      });
    }

    // GAP-2.3-A: reject rows whose (member, month/year) hits a locked salary.
    const lockedMonthCache = new Map<string, boolean>();
    const allowedEventDocs: typeof eventDocs = [];
    for (const doc of eventDocs) {
      if (!doc.teamMemberId) { allowedEventDocs.push(doc); continue; }
      const ts: Date = doc.timestamp as Date;
      const month = ts.getUTCMonth() + 1;
      const year = ts.getUTCFullYear();
      const cacheKey = `${String(doc.teamMemberId)}:${year}:${month}`;
      let locked = lockedMonthCache.get(cacheKey);
      if (locked === undefined) {
        const salary = await this.salaryModel
          .findOne({
            workspaceId: wsObjectId,
            teamMemberId: doc.teamMemberId,
            month, year,
          })
          .select('isLocked')
          .lean()
          .exec();
        locked = !!salary?.isLocked;
        lockedMonthCache.set(cacheKey, locked);
      }
      if (locked) {
        errors.push(
          `PAYROLL_LOCKED: row for member ${String(doc.teamMemberId)} on ${ts.toISOString()} rejected — payroll for ${year}-${String(month).padStart(2, '0')} is locked`,
        );
      } else {
        allowedEventDocs.push(doc);
      }
    }

    if (dto.dryRun) {
      // Count how many would be skipped (already have matching importHash in DB).
      const allHashes = allowedEventDocs
        .map((d) => d.importHash as string)
        .filter(Boolean);
      const existing = await this.eventModel
        .countDocuments({ wsId: wsObjectId, importHash: { $in: allHashes } })
        .exec();
      const willInsert = Math.max(0, allowedEventDocs.length - existing);
      return { inserted: 0, skipped: existing, willInsert, errors };
    }

    // Live commit — insertMany with ordered:false for per-row dedupe tolerance.
    let insertedCount = 0;
    try {
      const result = await (this.eventModel as any).insertMany(allowedEventDocs, {
        ordered: false,
      });
      insertedCount = Array.isArray(result) ? result.length : 0;
    } catch (err: any) {
      // BulkWriteError (E11000 duplicate key) — swallow, extract inserted count.
      // Pattern copied verbatim from AttendanceIngestService.handleAttlog().
      if (
        err?.name === 'MongoBulkWriteError' ||
        err?.code === 11000 ||
        err?.writeErrors
      ) {
        insertedCount =
          (err?.result?.insertedCount as number | undefined) ??  // Mongoose 7+/8+
          err?.result?.nInserted ??                              // Mongoose 6
          err?.insertedCount ??
          (err?.result?.result?.nInserted as number | undefined) ??
          0;
        if (insertedCount === 0) {
          this.logger.warn(
            '[AttendanceImport] BulkWriteError: could not extract insertedCount from error, defaulting to 0',
          );
        }
      } else {
        throw err;
      }
    }

    const skipped = allowedEventDocs.length - insertedCount;

    // D-09 (BUG-04): Guard against silent success when column mapping produces
    // zero insertable rows. If the file parsed to > 0 rows but insert count is 0
    // AND no row-level errors accumulated, the user's column map is almost
    // certainly misconfigured — surface this as a 400 instead of a green 200.
    const parsedRowCount = rows.length;
    if (parsedRowCount > 0 && insertedCount === 0 && skipped === 0 && errors.length === 0 && !dto.dryRun) {
      throw new BadRequestException(
        'EMPTY_RESULT: column mapping produced no insertable rows. Check your column mapping.',
      );
    }

    // Fire-and-forget projection recompute for inserted events with known members.
    if (insertedCount > 0) {
      setImmediate(() => {
        void this._recomputeProjections(
          wsId,
          allowedEventDocs as Array<{ teamMemberId: Types.ObjectId | null; timestamp: Date }>,
        );
      });
    }

    return { inserted: insertedCount, skipped, errors };
  }

  /**
   * Parse ALL rows from the file using the correct parser for the detected format.
   * For generic formats, applies the user-supplied columnMap.
   * Returns both the parsed rows and the detected format string so callers do not
   * need a separate detectAndParse() call just to obtain the format name.
   */
  private _parseAllRows(
    buffer: Buffer,
    originalName: string,
    columnMap: Record<string, string>,
  ): { rows: NormalisedRow[]; format: string } {
    // ZK .dat
    if (isZkDat(buffer, originalName)) {
      return { rows: parseZkDat(buffer), format: 'zk_dat' };
    }

    // eTimeTrackLite XLS/XLSX
    if (isETimeTrack(buffer, originalName)) {
      return { rows: parseETimeTrackXls(buffer), format: 'etimetrack_xls' };
    }

    // BioTime CSV
    if (isBioTimeCsv(buffer, originalName)) {
      return { rows: parseBioTimeCsv(buffer), format: 'biotime_csv' };
    }

    const ext = originalName.toLowerCase();

    // Generic XLS: convert to text then apply columnMap
    if (ext.endsWith('.xls') || ext.endsWith('.xlsx')) {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const csvText = XLSX.utils.sheet_to_csv(sheet);
      const csvBuffer = Buffer.from(csvText, 'utf8');
      const { headers, allRows } = parseGenericCsv(csvBuffer);
      return {
        rows: allRows
          .map((row) => applyColumnMap(headers, row, columnMap))
          .filter((r): r is NonNullable<typeof r> => r !== null) as NormalisedRow[],
        format: 'generic_xls',
      };
    }

    // Generic CSV / TXT
    const { headers, allRows } = parseGenericCsv(buffer);
    return {
      rows: allRows
        .map((row) => applyColumnMap(headers, row, columnMap))
        .filter((r): r is NonNullable<typeof r> => r !== null) as NormalisedRow[],
      format: 'generic_csv',
    };
  }

  /** Recompute daily projections for inserted events that have a known member. */
  private async _recomputeProjections(
    wsId: string,
    eventDocs: Array<{ teamMemberId: Types.ObjectId | null; timestamp: Date }>,
  ): Promise<void> {
    const seen = new Set<string>();
    for (const doc of eventDocs) {
      if (!doc.teamMemberId) continue;
      const memberId = String(doc.teamMemberId);
      const day = new Date(doc.timestamp);
      day.setUTCHours(0, 0, 0, 0);
      const key = `${memberId}:${day.toISOString()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        await this.projectionService.recompute(wsId, memberId, day);
      } catch (e: any) {
        this.logger.warn(
          `[AttendanceImport] Recompute failed member=${memberId} date=${day.toISOString()}: ${e.message}`,
        );
      }
    }
  }
}

/**
 * Compute importHash for file-upload event dedupe.
 * Source: RESEARCH.md §Dedupe Strategy.
 * D-10 (H4-02): deviceSerial intentionally excluded — callers cannot bypass dedupe
 * by changing dto.deviceSerial between re-uploads of the same file.
 */
function computeImportHash(
  wsId: string,
  teamMemberId: string | null,
  deviceUserId: string,
  timestamp: Date,
  punchType: string,
): string {
  const memberPart = teamMemberId
    ? teamMemberId
    : `UNASSIGNED:${deviceUserId}`;
  const input = [wsId, memberPart, timestamp.toISOString(), punchType].join(':');
  return crypto.createHash('sha256').update(input).digest('hex');
}
