import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/node';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { Holiday } from './schemas/holiday.schema';
import { CreateHolidayDto, UpdateHolidayDto } from './dto/holiday.dto';
import { AuditService } from '../audit/audit.service';
import { AppModule as AppModuleEnum } from '../../common/enums/modules.enum';
import { PostHogService } from '../../common/posthog/posthog.service';

/** Shape persisted by the update path - the DTO with `date` coerced to a Date. */
type HolidayUpdateData = Omit<UpdateHolidayDto, 'date'> & { date?: Date };

@Injectable()
export class HolidaysService {
  private readonly logger = new Logger(HolidaysService.name);
  private readonly tracer = trace.getTracer('holidays');

  constructor(
    @InjectModel(Holiday.name) private holidayModel: Model<Holiday>,
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
  ) {}

  /**
   * H2 - wrap a handler body with an OpenTelemetry span. Mirrors
   * `CompOffRequestService.withLeaveSpan` / `TeamService.withTeamSpan`. Span
   * attributes carry `workspaceId` / `userId` only - never raw PII.
   */
  private async withHolidaySpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span) => {
      try {
        span.setAttributes(attributes);
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error)?.message,
        });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /**
   * H2 - fire-and-forget audit-event helper for a holiday write. Mirrors
   * leave's `auditCompOffEvent`; a failure here never breaks the caller.
   * `actorId` is the acting USER (req.user.sub), per Playbook P8.
   */
  private auditHolidayEvent(input: {
    action: string;
    workspaceId: string;
    holidayId: string;
    actorId: string;
    meta?: Record<string, unknown>;
  }): void {
    void this.auditService
      .logEvent({
        workspaceId: input.workspaceId,
        module: AppModuleEnum.HOLIDAYS,
        entityType: 'holiday',
        entityId: input.holidayId,
        action: input.action,
        actorId: input.actorId,
        meta: input.meta,
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : 'unknown error';
        this.logger.warn(
          `Audit log failed for holiday event ${input.action} (workspace ${input.workspaceId}): ${detail}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'holidays', op: `audit.${input.action}` },
          extra: { workspaceId: input.workspaceId, actorId: input.actorId },
        });
      });
  }

  async findAll(workspaceId: string) {
    return this.withHolidaySpan('holiday.findAll', { workspaceId }, async () => {
      const holidays = await this.holidayModel.find({ workspaceId }).sort({ date: 1 }).exec();

      return holidays.map((h) => {
        const obj = h.toObject();
        return {
          ...obj,
          id: obj._id.toString(),
        };
      });
    });
  }

  async findByYear(workspaceId: string, year: number) {
    return this.withHolidaySpan('holiday.findByYear', { workspaceId, year }, async () => {
      const startDate = new Date(year, 0, 1);
      const endDate = new Date(year, 11, 31, 23, 59, 59);

      const holidays = await this.holidayModel
        .find({
          workspaceId,
          $or: [{ date: { $gte: startDate, $lte: endDate } }, { isRecurring: true }],
        })
        .sort({ date: 1 })
        .exec();

      const processedHolidays = holidays.map((h) => {
        const obj = h.toObject();
        let holidayDate = new Date(obj.date);

        if (h.isRecurring) {
          holidayDate = new Date(year, holidayDate.getMonth(), holidayDate.getDate());
        }

        return {
          ...obj,
          id: obj._id.toString(),
          date: holidayDate.toISOString(),
        };
      });

      return processedHolidays;
    });
  }

  async findByDate(workspaceId: string, date: string) {
    return this.withHolidaySpan('holiday.findByDate', { workspaceId }, async () => {
      const targetDate = new Date(date);
      const dayOfMonth = targetDate.getDate();
      const month = targetDate.getMonth() + 1;
      const startOfDay = new Date(targetDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(targetDate);
      endOfDay.setHours(23, 59, 59, 999);

      const holiday = await this.holidayModel.findOne({
        workspaceId,
        $or: [
          { date: { $gte: startOfDay, $lte: endOfDay } },
          {
            isRecurring: true,
            $expr: {
              $and: [
                { $eq: [{ $dayOfMonth: '$date' }, dayOfMonth] },
                { $eq: [{ $month: '$date' }, month] },
              ],
            },
          },
        ],
      });

      if (holiday) {
        const obj = holiday.toObject();
        return {
          ...obj,
          id: obj._id.toString(),
        };
      }
      return null;
    });
  }

  async create(workspaceId: string, userId: string, createDto: CreateHolidayDto) {
    return this.withHolidaySpan('holiday.create', { workspaceId, userId }, async () => {
      const existing = await this.holidayModel.findOne({
        workspaceId,
        date: new Date(createDto.date),
      });

      if (existing && !createDto.isRecurring) {
        throw new ConflictException('A holiday already exists on this date');
      }

      const holiday = new this.holidayModel({
        ...createDto,
        workspaceId,
        date: new Date(createDto.date),
        createdBy: userId,
      });

      // The unique {workspaceId, date} index is the authoritative guard - the
      // pre-check above skips recurring holidays, and a concurrent insert can
      // still race past it. Map Mongo E11000 to a friendly 409 either way
      // (mirrors the regularization DD-11 mapping).
      let saved: Holiday;
      try {
        saved = await holiday.save();
      } catch (err: unknown) {
        if ((err as { code?: number })?.code === 11000) {
          throw new ConflictException('A holiday already exists on this date');
        }
        throw err;
      }

      const holidayId = saved._id.toString();

      this.auditHolidayEvent({
        action: 'holiday.created',
        workspaceId,
        holidayId,
        actorId: userId,
        meta: {
          name: saved.name,
          type: saved.type,
          isRecurring: saved.isRecurring,
        },
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'holiday.created',
        properties: {
          workspaceId,
          holidayId,
          type: saved.type,
          isRecurring: saved.isRecurring,
        },
      });

      return saved;
    });
  }

  /**
   * (A) Bulk holiday creation — declare many holidays in one round-trip.
   *
   * Strategy: build all docs up front and `insertMany(..., { ordered: false })`
   * so a duplicate on one date does NOT abort the rest of the batch (mirrors the
   * attendance-import ordered:false dedupe pattern). The unique {workspaceId,date}
   * index is the authoritative guard; any E11000 write-error is treated as a
   * SKIP (reason 'already_exists') rather than a hard failure, so re-running the
   * same calendar import is idempotent and partial overlaps are tolerated.
   *
   * Returns the created rows plus a per-date skip list so the caller can show
   * "12 created, 3 already existed". Audit + PostHog fire ONE batch event (not N)
   * to avoid flooding the trail — mirrors the single-create instrumentation shape.
   */
  async bulkCreate(workspaceId: string, userId: string, dtos: CreateHolidayDto[]) {
    return this.withHolidaySpan(
      'holiday.bulkCreate',
      { workspaceId, userId, count: dtos.length },
      async () => {
        const wsObjectId = new Types.ObjectId(workspaceId);
        const createdByObjectId = new Types.ObjectId(userId);

        // Map each prepared doc back to its source date string so a write-error
        // at index N can report the human-readable date that was skipped.
        const docs = dtos.map((dto) => ({
          name: dto.name,
          date: new Date(dto.date),
          description: dto.description,
          isRecurring: dto.isRecurring ?? false,
          type: dto.type ?? 'national',
          workspaceId: wsObjectId,
          createdBy: createdByObjectId,
        }));

        let inserted: Holiday[] = [];
        const skipped: Array<{ date: string; reason: string }> = [];

        try {
          // ordered:false → continue past dup-key rows; insertMany returns only
          // the successfully-inserted docs.
          inserted = (await this.holidayModel.insertMany(docs, {
            ordered: false,
          })) as unknown as Holiday[];
        } catch (err: unknown) {
          // BulkWriteError: some rows inserted, some collided with the unique
          // {workspaceId,date} index. Pull the successfully-inserted docs and map
          // each writeError back to its original date via its array index.
          // Extraction shape mirrors AttendanceImportService's BulkWriteError path.
          const bulkErr = err as {
            code?: number;
            name?: string;
            writeErrors?: Array<{
              code?: number;
              index?: number;
              err?: { code?: number; index?: number };
            }>;
            insertedDocs?: Holiday[];
            result?: { insertedIds?: Record<string, unknown> };
          };

          const isBulkWriteError =
            bulkErr?.name === 'MongoBulkWriteError' ||
            bulkErr?.code === 11000 ||
            Array.isArray(bulkErr?.writeErrors);

          if (!isBulkWriteError) {
            throw err;
          }

          // insertedDocs holds the rows that DID land (Mongoose attaches it on
          // ordered:false bulk errors).
          inserted = bulkErr.insertedDocs ?? [];

          for (const we of bulkErr.writeErrors ?? []) {
            // writeError nests its code/index under .err on some driver versions.
            const code = we.code ?? we.err?.code;
            const idx = we.index ?? we.err?.index;
            if (code === 11000 && typeof idx === 'number' && docs[idx]) {
              skipped.push({
                date: dtos[idx].date,
                reason: 'already_exists',
              });
            } else {
              // A non-duplicate write-error is unexpected — surface it rather
              // than silently swallowing data-integrity failures.
              throw err;
            }
          }
        }

        const createdIds = inserted.map((h) => h._id.toString());

        // ONE batch audit event (not N) — keeps the audit trail readable.
        // A batch has no single holiday entity; AuditService.logEvent runs the
        // entityId through `new Types.ObjectId(...)`, which throws on a non-hex
        // string like 'batch' (the throw is swallowed but the event is lost).
        // Use the workspaceId as the entity reference — it is a valid ObjectId and
        // scopes the batch event to the workspace; the createdIds list in `meta`
        // carries the actual per-holiday detail.
        this.auditHolidayEvent({
          action: 'holiday.bulk_created',
          workspaceId,
          holidayId: workspaceId,
          actorId: userId,
          meta: {
            requested: dtos.length,
            created: createdIds.length,
            skipped: skipped.length,
            createdIds,
          },
        });

        this.postHog.capture({
          distinctId: userId,
          event: 'holiday.bulk_created',
          properties: {
            workspaceId,
            requested: dtos.length,
            created: createdIds.length,
            skipped: skipped.length,
          },
        });

        return { created: inserted, skipped };
      },
    );
  }

  /**
   * (B) Holiday resolver for the attendance auto-present cron.
   *
   * Returns true when `date` falls on a declared holiday for this workspace,
   * matching either an exact-date holiday OR a recurring holiday by day+month.
   * Reuses the same exact-date-window + recurring day/month $expr predicate as
   * `findByDate`, but is a lean existence check (O(1) per workspace/day) — the
   * cron resolves the day's holiday ONCE per workspace, never per member, so
   * this must stay a single indexed lookup with no document hydration.
   */
  async isHolidayOn(workspaceId: string, date: Date): Promise<boolean> {
    const targetDate = new Date(date);
    const dayOfMonth = targetDate.getUTCDate();
    const month = targetDate.getUTCMonth() + 1;
    const startOfDay = new Date(targetDate);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const match = await this.holidayModel
      .exists({
        workspaceId: new Types.ObjectId(workspaceId),
        $or: [
          { date: { $gte: startOfDay, $lte: endOfDay } },
          {
            isRecurring: true,
            $expr: {
              $and: [
                { $eq: [{ $dayOfMonth: '$date' }, dayOfMonth] },
                { $eq: [{ $month: '$date' }, month] },
              ],
            },
          },
        ],
      })
      .exec();

    return match != null;
  }

  async update(
    workspaceId: string,
    holidayId: string,
    userId: string,
    updateDto: UpdateHolidayDto,
  ) {
    return this.withHolidaySpan('holiday.update', { workspaceId, userId }, async () => {
      const updateData: HolidayUpdateData = { ...updateDto };
      if (updateDto.date) {
        updateData.date = new Date(updateDto.date);
      }

      let holiday: Holiday | null;
      try {
        holiday = await this.holidayModel
          .findOneAndUpdate({ _id: holidayId, workspaceId }, updateData, {
            new: true,
          })
          .exec();
      } catch (err: unknown) {
        // Moving a holiday onto a date already taken by another row trips the
        // unique {workspaceId, date} index - surface the same friendly 409.
        if ((err as { code?: number })?.code === 11000) {
          throw new ConflictException('A holiday already exists on this date');
        }
        throw err;
      }

      if (!holiday) {
        throw new NotFoundException('Holiday not found');
      }

      this.auditHolidayEvent({
        action: 'holiday.updated',
        workspaceId,
        holidayId,
        actorId: userId,
        meta: { fields: Object.keys(updateDto) },
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'holiday.updated',
        properties: {
          workspaceId,
          holidayId,
          fields: Object.keys(updateDto),
        },
      });

      const obj = holiday.toObject();
      return {
        ...obj,
        id: obj._id.toString(),
      };
    });
  }

  async remove(workspaceId: string, holidayId: string, userId: string) {
    return this.withHolidaySpan('holiday.remove', { workspaceId, userId }, async () => {
      const holiday = await this.holidayModel
        .findOneAndDelete({ _id: holidayId, workspaceId })
        .exec();

      if (!holiday) {
        throw new NotFoundException('Holiday not found');
      }

      this.auditHolidayEvent({
        action: 'holiday.deleted',
        workspaceId,
        holidayId,
        actorId: userId,
        meta: { name: holiday.name, type: holiday.type },
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'holiday.deleted',
        properties: {
          workspaceId,
          holidayId,
          type: holiday.type,
        },
      });

      return { success: true };
    });
  }
}
