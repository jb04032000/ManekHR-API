import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/node';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { Shift } from './schemas/shift.schema';
import { CreateShiftDto, UpdateShiftDto } from './dto/shift.dto';
import { TeamMember } from '../team/schemas/team-member.schema';
import { AuditService } from '../audit/audit.service';
import { AppModule as AppModuleEnum } from '../../common/enums/modules.enum';
import { PostHogService } from '../../common/posthog/posthog.service';

/**
 * Shape persisted by the update path. The Shift DTO has no date-style fields
 * that need coercion, so this is a pass-through alias today. Kept as a named
 * type (mirroring `HolidayUpdateData`) so the update site has no `any`.
 */
type ShiftUpdateData = Partial<UpdateShiftDto>;

@Injectable()
export class ShiftsService {
  private readonly logger = new Logger(ShiftsService.name);
  private readonly tracer = trace.getTracer('shifts');

  constructor(
    @InjectModel(Shift.name) private shiftModel: Model<Shift>,
    @InjectModel(TeamMember.name) private teamModel: Model<TeamMember>,
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
  ) {}

  /**
   * S2 - wrap a handler body with an OpenTelemetry span. Mirrors
   * `HolidaysService.withHolidaySpan`. Span attributes carry `workspaceId` /
   * `userId` only, never raw PII.
   */
  private async withShiftSpan<T>(
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
   * S2 - fire-and-forget audit-event helper for a shift write. Mirrors
   * `HolidaysService.auditHolidayEvent`. A failure here never breaks the
   * caller. `actorId` is the acting USER (req.user.sub), per Playbook P8.
   */
  private auditShiftEvent(input: {
    action: string;
    workspaceId: string;
    shiftId: string;
    actorId: string;
    meta?: Record<string, unknown>;
  }): void {
    void this.auditService
      .logEvent({
        workspaceId: input.workspaceId,
        module: AppModuleEnum.SHIFTS,
        entityType: 'shift',
        entityId: input.shiftId,
        action: input.action,
        actorId: input.actorId,
        meta: input.meta,
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : 'unknown error';
        this.logger.warn(
          `Audit log failed for shift event ${input.action} (workspace ${input.workspaceId}): ${detail}`,
        );
        Sentry.captureException(err, {
          tags: { module: 'shifts', op: `audit.${input.action}` },
          extra: { workspaceId: input.workspaceId, actorId: input.actorId },
        });
      });
  }

  async findAll(workspaceId: string) {
    return this.withShiftSpan('shift.findAll', { workspaceId }, async () => {
      const shifts = await this.shiftModel.find({ workspaceId }).exec();

      // Calculate member counts for each shift in this workspace
      const memberCounts = await this.teamModel.aggregate([
        {
          $match: {
            // Match by workspaceId (handle string or ObjectId if needed, though schema says ObjectId)
            $or: [{ workspaceId: new Types.ObjectId(workspaceId) }, { workspaceId: workspaceId }],
            isActive: { $ne: false }, // Catch both true and undefined
            shiftId: { $exists: true, $ne: null },
          },
        },
        {
          $project: {
            shiftIdStr: { $toString: '$shiftId' },
          },
        },
        {
          $group: {
            _id: '$shiftIdStr',
            count: { $sum: 1 },
          },
        },
      ]);

      const countMap = memberCounts.reduce((acc, curr) => {
        if (curr._id) {
          acc[curr._id.toString()] = curr.count;
        }
        return acc;
      }, {});

      return shifts.map((shift) => {
        const shiftObj = shift.toObject();
        return {
          ...shiftObj,
          id: shiftObj._id.toString(),
          memberCount: countMap[shiftObj._id.toString()] || 0,
        };
      });
    });
  }

  async create(workspaceId: string, userId: string, createDto: CreateShiftDto) {
    return this.withShiftSpan('shift.create', { workspaceId, userId }, async () => {
      const shift = new this.shiftModel({
        ...createDto,
        workspaceId,
        createdBy: userId,
      });
      const saved = await shift.save();
      const shiftId = saved._id.toString();

      this.auditShiftEvent({
        action: 'shift.created',
        workspaceId,
        shiftId,
        actorId: userId,
        meta: {
          name: saved.name,
          shiftType: saved.shiftType,
          isDefault: saved.isDefault,
        },
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'shift.created',
        properties: {
          workspaceId,
          shiftId,
          name: saved.name,
          shiftType: saved.shiftType,
          isDefault: saved.isDefault,
        },
      });

      return saved;
    });
  }

  async update(workspaceId: string, shiftId: string, userId: string, updateDto: UpdateShiftDto) {
    return this.withShiftSpan('shift.update', { workspaceId, userId }, async () => {
      const updateData: ShiftUpdateData = { ...updateDto };

      const shift = await this.shiftModel
        .findOneAndUpdate({ _id: shiftId, workspaceId }, updateData, { new: true })
        .exec();
      if (!shift) throw new NotFoundException('Shift not found');

      this.auditShiftEvent({
        action: 'shift.updated',
        workspaceId,
        shiftId,
        actorId: userId,
        meta: { fields: Object.keys(updateDto) },
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'shift.updated',
        properties: {
          workspaceId,
          shiftId,
          fields: Object.keys(updateDto),
        },
      });

      return shift;
    });
  }

  async remove(workspaceId: string, shiftId: string, userId: string) {
    return this.withShiftSpan('shift.remove', { workspaceId, userId }, async () => {
      const shift = await this.shiftModel.findOneAndDelete({ _id: shiftId, workspaceId }).exec();
      if (!shift) throw new NotFoundException('Shift not found');

      this.auditShiftEvent({
        action: 'shift.deleted',
        workspaceId,
        shiftId,
        actorId: userId,
        meta: { name: shift.name, shiftType: shift.shiftType },
      });

      this.postHog.capture({
        distinctId: userId,
        event: 'shift.deleted',
        properties: {
          workspaceId,
          shiftId,
          name: shift.name,
          shiftType: shift.shiftType,
        },
      });

      // Optional: remove shift from members or keep historical reference if needed
      // await this.teamModel.updateMany({ shiftId }, { $unset: { shiftId: 1 } }).exec();
    });
  }
}
