import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { PolicyDeniedException } from '../../common/exceptions/policy-denied.exception';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { RegularizationRequest } from './schemas/regularization-request.schema';
import { RegularizationResolverService } from './regularization-resolver.service';
import { AttendanceEventService } from '../attendance/attendance-event.service';
import { AttendanceProjectionService } from '../attendance/attendance-projection.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { AppModule as AppModuleEnum } from '../../common/enums/modules.enum';
import { PostHogService } from '../../common/posthog/posthog.service';

/**
 * Pitfall 1 mitigation — translates the user-facing UPPERCASE enum (DD-5) to
 * the storage-layer lowercase attendance enum. LEAVE maps to 'on_leave' (not 'leave').
 */
export const STATUS_MAP: Record<'PRESENT' | 'HALF_DAY' | 'LEAVE' | 'ABSENT', string> = {
  PRESENT: 'present',
  HALF_DAY: 'half_day',
  LEAVE: 'on_leave',
  ABSENT: 'absent',
};

export const DEFAULT_REG_CONFIG = {
  approvalLevels: 1,
  fallbackApprover: null as string | null,
  maxDaysBack: 30,
  maxAttachmentsPerRequest: 3,
};

export interface CreateRegularizationInput {
  wsId: string;
  raisedBy: string; // User._id
  memberId: string;
  date: string; // YYYY-MM-DD, UTC midnight
  requestedStatus: 'PRESENT' | 'HALF_DAY' | 'LEAVE' | 'ABSENT';
  requestedCheckIn?: string | null;
  requestedCheckOut?: string | null;
  reason: string;
  /** Optional reason category (additive); validated by the DTO enum. */
  reasonCategory?: string | null;
  attachments?: string[];
  /**
   * True when the caller raised this for themselves under a `self`-scoped
   * `manage_regularizations` grant (Access Control Initiative §8 B2). When
   * set, `create` additionally enforces the workspace self-service policy
   * toggle. Absent / false for admin-raised requests.
   */
  selfScoped?: boolean;
}

@Injectable()
export class RegularizationService {
  private readonly logger = new Logger(RegularizationService.name);

  constructor(
    @InjectModel(RegularizationRequest.name)
    private readonly requestModel: Model<RegularizationRequest>,
    @InjectModel('Workspace') private readonly workspaceModel: Model<any>,
    @InjectModel('TeamMember') private readonly teamMemberModel: Model<any>,
    @InjectModel('Salary') private readonly salaryModel: Model<any>,
    @InjectModel('Attendance') private readonly attendanceModel: Model<any>,
    @InjectModel('User') private readonly userModel: Model<any>,
    private readonly resolver: RegularizationResolverService,
    @Inject(forwardRef(() => AttendanceEventService))
    private readonly eventService: AttendanceEventService,
    @Inject(forwardRef(() => AttendanceProjectionService))
    private readonly projectionService: AttendanceProjectionService,
    private readonly mailService: MailService,
    private readonly notificationsService: NotificationsService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
  ) {}

  /**
   * Fire-and-forget audit + PostHog for a regularization write. `actorId` is
   * the ACTING user (raiser on create/cancel, approver on approve/reject),
   * never the target member. A failure here never breaks the caller. Meta is a
   * coarse, non-sensitive descriptor only (level / isFinal) — never raw
   * attendance values.
   */
  private recordRegularizationWrite(
    action: string,
    request: { _id: unknown; wsId: unknown; memberId: unknown },
    actorId: string,
    meta?: Record<string, unknown>,
  ): void {
    const wsId = String(request.wsId);
    const regularizationId = String(request._id);
    const teamMemberId = String(request.memberId);
    void this.auditService
      .logEvent({
        workspaceId: wsId,
        module: AppModuleEnum.REGULARIZATION,
        entityType: 'regularization_request',
        entityId: regularizationId,
        action,
        actorId,
        teamMemberId,
        meta,
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `regularization audit log failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      });
    this.postHog.capture({
      distinctId: actorId,
      event: action,
      properties: { workspaceId: wsId, regularizationId, teamMemberId, ...(meta ?? {}) },
    });
  }

  // -------- CREATE --------
  async create(input: CreateRegularizationInput): Promise<RegularizationRequest> {
    const wsObjId = new Types.ObjectId(input.wsId);
    const memberObjId = new Types.ObjectId(input.memberId);

    // Parse date as UTC midnight
    const dateObj = this._parseDateUtcMidnight(input.date);

    // Load workspace config (Pitfall 5: wsId scoping + runtime defaults)
    const ws = await this.workspaceModel.findById(wsObjId).lean().exec();
    if (!ws) throw new NotFoundException('Workspace not found');

    // Self-service policy gate — a self-scoped raiser (Worker self-service)
    // may only raise when the owner has enabled self-service correction
    // requests for the workspace. Admin-raised requests bypass this.
    if (input.selfScoped && !ws.selfServiceConfig?.selfLeaveApply) {
      throw new PolicyDeniedException(
        'SELF_REGULARIZATION_DISABLED',
        'Self-service correction requests are turned off for this workspace. Ask an admin to enable them.',
      );
    }

    const cfg = { ...DEFAULT_REG_CONFIG, ...(ws.regularizationConfig ?? {}) };

    // DD-6 maxDaysBack
    const today = this._startOfUtcDay(new Date());
    const diffDays = Math.floor((today.getTime() - dateObj.getTime()) / (24 * 60 * 60 * 1000));
    if (diffDays > cfg.maxDaysBack || diffDays < 0) {
      throw new BadRequestException(
        `MAX_DAYS_BACK_EXCEEDED: request date is ${diffDays} days in the past; max allowed is ${cfg.maxDaysBack}`,
      );
    }

    // DD-7 Salary.isLocked gate (Pitfall 6: UTC month+1)
    await this._assertPayrollNotLocked(wsObjId, memberObjId, dateObj, 'at create');

    // Attachments cap
    if ((input.attachments?.length ?? 0) > cfg.maxAttachmentsPerRequest) {
      throw new BadRequestException(`Too many attachments — max ${cfg.maxAttachmentsPerRequest}`);
    }

    // Snapshot currentStatus from existing Attendance row (nullable)
    const existing = await this.attendanceModel
      .findOne({ workspaceId: wsObjId, teamMemberId: memberObjId, date: dateObj })
      .select('status')
      .lean()
      .exec();
    const currentStatus: string | null = existing?.status ?? null;

    // Snapshot approver chain (assumption A3: snapshot-at-create)
    const fallback = cfg.fallbackApprover ? String(cfg.fallbackApprover) : null;
    const chain = await this.resolver.resolveApprovers({
      wsId: input.wsId,
      memberId: input.memberId,
      approvalLevels: cfg.approvalLevels,
      fallbackApproverUserId: fallback,
    });

    // Self-approval prevention (T-D-04-02): member's own linkedUserId must not appear in chain
    const member = await this.teamMemberModel
      .findOne({ _id: memberObjId, workspaceId: wsObjId })
      .select('linkedUserId')
      .lean()
      .exec();
    if (member?.linkedUserId) {
      const memberUserId = member.linkedUserId.toString();
      if (chain.some((s) => s.approverUserId.toString() === memberUserId)) {
        throw new BadRequestException(
          'SELF_APPROVAL_FORBIDDEN: member appears as their own approver in resolved chain',
        );
      }
    }

    // Attempt insert — catch E11000 for DD-11
    try {
      const doc = await this.requestModel.create({
        wsId: wsObjId,
        memberId: memberObjId,
        raisedBy: new Types.ObjectId(input.raisedBy),
        date: dateObj,
        currentStatus,
        requestedStatus: input.requestedStatus,
        requestedCheckIn: input.requestedCheckIn ? new Date(input.requestedCheckIn) : null,
        requestedCheckOut: input.requestedCheckOut ? new Date(input.requestedCheckOut) : null,
        reason: input.reason,
        reasonCategory: input.reasonCategory ?? null,
        attachments: input.attachments ?? [],
        status: 'pending',
        approvalChain: chain.map((c) => ({
          level: c.level,
          approverUserId: c.approverUserId,
          decision: null,
          decidedAt: null,
          note: null,
        })),
        currentLevel: 1,
        finalDecisionAt: null,
        resultingEventId: null,
      });
      this.recordRegularizationWrite('regularization.requested', doc, input.raisedBy);
      return doc;
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException(
          'PENDING_REGULARIZATION_EXISTS: a pending request already exists for this member/date',
        );
      }
      throw err;
    }
  }

  // -------- CANCEL (DD-13) --------
  async cancel(wsId: string, requestId: string, userId: string): Promise<RegularizationRequest> {
    const wsObjId = new Types.ObjectId(wsId);
    const req = await this.requestModel
      .findOne({ _id: new Types.ObjectId(requestId), wsId: wsObjId })
      .exec();
    if (!req) throw new NotFoundException('Regularization request not found');

    if (req.raisedBy.toString() !== userId) {
      throw new ForbiddenException('CANCEL_FORBIDDEN: only the raiser can cancel');
    }
    if (req.status !== 'pending') {
      throw new ForbiddenException(`CANCEL_FORBIDDEN: request is ${req.status}, not pending`);
    }
    if (req.currentLevel > 1) {
      throw new ForbiddenException(
        'CANCEL_FORBIDDEN: at least one level has approved; cancel disabled',
      );
    }
    req.status = 'cancelled';
    req.finalDecisionAt = new Date();
    const cancelled = await req.save();
    this.recordRegularizationWrite('regularization.cancelled', cancelled, userId);
    return cancelled;
  }

  // -------- APPROVE (atomic, Pitfall 4) --------
  async approveStep(
    wsId: string,
    requestId: string,
    approverUserId: string,
    note?: string,
  ): Promise<RegularizationRequest & { salaryInvalidated?: boolean; invalidatedMonth?: string }> {
    const wsObjId = new Types.ObjectId(wsId);
    const reqId = new Types.ObjectId(requestId);

    // Read (non-atomic) to determine expected currentLevel and check approver identity
    const existing = await this.requestModel.findOne({ _id: reqId, wsId: wsObjId }).exec();
    if (!existing) throw new NotFoundException('Regularization request not found');
    if (existing.status !== 'pending') {
      throw new ConflictException('REQUEST_ALREADY_DECIDED: not pending');
    }

    const expectedLevel = existing.currentLevel;
    const step = existing.approvalChain[expectedLevel - 1];
    if (!step || step.approverUserId.toString() !== approverUserId) {
      throw new ForbiddenException(
        'NOT_APPROVER: user is not the current-level approver for this request',
      );
    }

    // A5 defensive: re-check Salary.isLocked at approval time
    await this._assertPayrollNotLocked(wsObjId, existing.memberId, existing.date, 'at approve');

    // Pitfall 4 — atomic advance. Only the winner of a race updates the doc.
    // Use snapshotted chain length (assumption A3: snapshot-at-create).
    // Live config is intentionally NOT used here to prevent mid-flight config changes
    // from affecting in-progress requests.
    const isFinal = expectedLevel >= existing.approvalChain.length;

    const setOps: Record<string, unknown> = {
      [`approvalChain.${expectedLevel - 1}.decision`]: 'approved',
      [`approvalChain.${expectedLevel - 1}.decidedAt`]: new Date(),
      [`approvalChain.${expectedLevel - 1}.note`]: note ?? null,
    };
    if (isFinal) {
      setOps.status = 'approved';
      setOps.finalDecisionAt = new Date();
    } else {
      setOps.currentLevel = expectedLevel + 1;
    }

    const updated = await this.requestModel
      .findOneAndUpdate(
        {
          _id: reqId,
          wsId: wsObjId,
          status: 'pending',
          currentLevel: expectedLevel,
        },
        { $set: setOps },
        { new: true },
      )
      .exec();

    if (!updated) {
      throw new ConflictException(
        'REQUEST_ALREADY_DECIDED: concurrent decision advanced this request',
      );
    }

    if (!isFinal) {
      this.recordRegularizationWrite('regularization.approved', updated, approverUserId, {
        level: expectedLevel,
        isFinal: false,
      });
      return updated;
    }

    // Final approval — write AttendanceEvent + trigger recompute (DD-15)
    // Pitfall 8: all ObjectIds cast to string in sourceMeta
    const sourceMeta = {
      regRequestId: updated._id.toString(),
      requestedCheckIn: updated.requestedCheckIn?.toISOString() ?? null,
      requestedCheckOut: updated.requestedCheckOut?.toISOString() ?? null,
      approvalChain: updated.approvalChain.map((s) => ({
        level: s.level,
        approverUserId: s.approverUserId.toString(),
        decision: s.decision,
        decidedAt: s.decidedAt?.toISOString() ?? null,
        note: s.note,
      })),
    };

    const event = await this.eventService.createEvent({
      wsId: wsObjId,
      teamMemberId: updated.memberId,
      timestamp: updated.date, // UTC midnight of regularized day
      punchType: 'STATUS_SET',
      statusValue: STATUS_MAP[updated.requestedStatus], // Pitfall 1
      source: 'regularization',
      markedBy: new Types.ObjectId(approverUserId),
      sourceMeta,
    });

    await this.projectionService.recompute(wsId, updated.memberId.toString(), updated.date);

    // D-06 (GAP-2.2-B): If an UNLOCKED Salary exists for the affected month, flag the request
    // so the payroll manager knows the salary may drift. No auto-recompute — manual re-run only.
    const approvedDate: Date = updated.date;
    const affectedMonth = approvedDate.getUTCMonth() + 1; // 1..12
    const affectedYear = approvedDate.getUTCFullYear();
    const affectedSalary = await this.salaryModel
      .findOne({
        workspaceId: wsObjId,
        teamMemberId: updated.memberId,
        month: affectedMonth,
        year: affectedYear,
        isLocked: false,
      })
      .select('_id')
      .lean()
      .exec();
    if (affectedSalary) {
      updated.salaryInvalidated = true;
      // Persisted below when updated.save() runs for resultingEventId back-link.
    }

    // Back-link the event on the request
    updated.resultingEventId = event._id;
    await updated.save();

    this.recordRegularizationWrite('regularization.approved', updated, approverUserId, {
      level: expectedLevel,
      isFinal: true,
    });

    if (updated.salaryInvalidated) {
      const monthStr = `${affectedYear}-${String(affectedMonth).padStart(2, '0')}`;
      return Object.assign(updated, { invalidatedMonth: monthStr });
    }
    return updated;
  }

  // -------- REJECT --------
  async reject(
    wsId: string,
    requestId: string,
    approverUserId: string,
    note?: string,
  ): Promise<RegularizationRequest> {
    const wsObjId = new Types.ObjectId(wsId);
    const reqId = new Types.ObjectId(requestId);

    const existing = await this.requestModel.findOne({ _id: reqId, wsId: wsObjId }).exec();
    if (!existing) throw new NotFoundException('Regularization request not found');
    if (existing.status !== 'pending') {
      throw new ConflictException('REQUEST_ALREADY_DECIDED: not pending');
    }

    const expectedLevel = existing.currentLevel;
    const step = existing.approvalChain[expectedLevel - 1];
    if (!step || step.approverUserId.toString() !== approverUserId) {
      throw new ForbiddenException('NOT_APPROVER');
    }

    const updated = await this.requestModel
      .findOneAndUpdate(
        {
          _id: reqId,
          wsId: wsObjId,
          status: 'pending',
          currentLevel: expectedLevel,
        },
        {
          $set: {
            status: 'rejected',
            finalDecisionAt: new Date(),
            [`approvalChain.${expectedLevel - 1}.decision`]: 'rejected',
            [`approvalChain.${expectedLevel - 1}.decidedAt`]: new Date(),
            [`approvalChain.${expectedLevel - 1}.note`]: note ?? null,
          },
        },
        { new: true },
      )
      .exec();

    if (!updated) {
      throw new ConflictException('REQUEST_ALREADY_DECIDED');
    }
    this.recordRegularizationWrite('regularization.rejected', updated, approverUserId);
    return updated;
  }

  // -------- LIST METHODS --------

  /**
   * Returns requests where the current-level step's approverUserId === userId.
   * Used for "Pending for me" tab.
   */
  async findPendingForUser(wsId: string, userId: string) {
    const wsObjId = new Types.ObjectId(wsId);
    return this.requestModel
      .find({
        wsId: wsObjId,
        status: 'pending',
        $expr: {
          $eq: [
            {
              $toString: {
                $getField: {
                  field: 'approverUserId',
                  input: {
                    $arrayElemAt: ['$approvalChain', { $subtract: ['$currentLevel', 1] }],
                  },
                },
              },
            },
            userId,
          ],
        },
      })
      .sort({ createdAt: -1 })
      .populate('memberId', 'name employeeCode')
      .populate('raisedBy', 'name email')
      .lean()
      .exec();
  }

  /** Returns requests raised by the given user, newest first. */
  async findMyRequests(wsId: string, userId: string) {
    return this.requestModel
      .find({
        wsId: new Types.ObjectId(wsId),
        raisedBy: new Types.ObjectId(userId),
      })
      .sort({ createdAt: -1 })
      .populate('memberId', 'name employeeCode')
      .lean()
      .exec();
  }

  /** Returns all requests in workspace with optional filters. */
  async findAll(
    wsId: string,
    filters: { status?: string; memberId?: string; from?: string; to?: string } = {},
  ) {
    const q: Record<string, unknown> = { wsId: new Types.ObjectId(wsId) };
    if (filters.status) q.status = filters.status;
    if (filters.memberId) q.memberId = new Types.ObjectId(filters.memberId);
    if (filters.from || filters.to) {
      q.date = {};
      if (filters.from) (q.date as Record<string, Date>).$gte = new Date(filters.from);
      if (filters.to) (q.date as Record<string, Date>).$lte = new Date(filters.to);
    }
    return this.requestModel
      .find(q)
      .sort({ createdAt: -1 })
      .populate('memberId', 'name employeeCode')
      .populate('raisedBy', 'name email')
      .lean()
      .exec();
  }

  /** Returns a single request with full approvalChain populated. */
  async findOne(wsId: string, requestId: string) {
    const doc = await this.requestModel
      .findOne({
        _id: new Types.ObjectId(requestId),
        wsId: new Types.ObjectId(wsId),
      })
      .populate('memberId', 'name employeeCode')
      .populate('raisedBy', 'name email')
      .populate('approvalChain.approverUserId', 'name email')
      .lean()
      .exec();
    if (!doc) throw new NotFoundException('Regularization request not found');
    return doc;
  }

  // -------- PRIVATE HELPERS --------

  private async _loadConfig(wsObjId: Types.ObjectId) {
    const ws = await this.workspaceModel.findById(wsObjId).lean().exec();
    if (!ws) throw new NotFoundException('Workspace not found');
    return { ...DEFAULT_REG_CONFIG, ...(ws.regularizationConfig ?? {}) };
  }

  /**
   * Check Salary.isLocked for the (workspace, member, month/year) tuple.
   * Pitfall 6: use getUTCMonth() + 1 (not getMonth()).
   */
  private async _assertPayrollNotLocked(
    wsObjId: Types.ObjectId,
    memberObjId: Types.ObjectId,
    date: Date,
    context: 'at create' | 'at approve',
  ): Promise<void> {
    const month = date.getUTCMonth() + 1; // Pitfall 6 — 1-indexed
    const year = date.getUTCFullYear();
    const salary = await this.salaryModel
      .findOne({
        workspaceId: wsObjId,
        teamMemberId: memberObjId,
        month,
        year,
      })
      .select('isLocked')
      .lean()
      .exec();
    if (salary?.isLocked) {
      const code = context === 'at create' ? 'PAYROLL_LOCKED' : 'PAYROLL_LOCKED_SINCE_CREATE';
      throw new BadRequestException(
        `${code}: payroll for ${year}-${String(month).padStart(2, '0')} is locked; regularization not permitted`,
      );
    }
  }

  /** Parse YYYY-MM-DD string to UTC midnight Date. */
  private _parseDateUtcMidnight(dateStr: string): Date {
    const [y, m, d] = dateStr.split('-').map(Number);
    if (!y || !m || !d) {
      throw new BadRequestException('INVALID_DATE: expected YYYY-MM-DD');
    }
    return new Date(Date.UTC(y, m - 1, d));
  }

  /** Return UTC midnight of the given Date. */
  private _startOfUtcDay(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  // =============== NOTIFICATIONS (DD-14) ===============

  private _getWebAppUrl(): string {
    return this.configService.get<string>('app.webAppUrl') ?? 'https://app.manekhr.in';
  }

  private async _fetchUserLite(userId: Types.ObjectId | string) {
    return this.userModel.findById(userId).select('email name').lean().exec();
  }

  /** Notify the current L1 approver on create. */
  async notifyNewApprover(wsId: string, req: any): Promise<void> {
    try {
      const ws = await this.workspaceModel.findById(new Types.ObjectId(wsId)).select('name').lean();
      const member = await this.teamMemberModel.findById(req.memberId).select('name').lean();
      const raiser = await this._fetchUserLite(req.raisedBy);
      const approverStep = req.approvalChain[req.currentLevel - 1];
      if (!approverStep) return;
      const approver = await this._fetchUserLite(approverStep.approverUserId);
      if (!approver) return;

      const reviewUrl = `${this._getWebAppUrl()}/dashboard/attendance/regularizations/${req._id}`;

      this.notificationsService
        .createNotification(wsId, {
          recipientId: approver._id.toString(),
          title: 'Regularization awaiting approval',
          message: `${raiser?.name ?? 'Admin'} raised a request for ${member?.name ?? 'a member'} on ${new Date(req.date).toISOString().slice(0, 10)}`,
          type: 'info',
          metadata: {
            entityId: req._id.toString(),
            entityType: 'regularization_request',
          },
        })
        .catch(() => {});

      this.mailService
        .sendRegularizationPendingApprover(
          { email: approver.email, name: approver.name },
          {
            raiserName: raiser?.name ?? 'Admin',
            memberName: member?.name ?? 'a member',
            date: new Date(req.date).toISOString().slice(0, 10),
            requestedStatus: req.requestedStatus,
            reason: req.reason,
            wsName: ws?.name ?? 'Workspace',
            reviewUrl,
          },
        )
        .catch(() => {});
    } catch (err: any) {
      this.logger.warn(`notifyNewApprover failed: ${err?.message}`);
    }
  }

  /** On approval: notify next-level approver (if not final), or raiser + member (if final). */
  async notifyAfterApproval(wsId: string, req: any): Promise<void> {
    try {
      const ws = await this.workspaceModel.findById(new Types.ObjectId(wsId)).select('name').lean();
      const member = await this.teamMemberModel
        .findById(req.memberId)
        .select('name linkedUserId')
        .lean();
      const isFinal = req.status === 'approved';

      if (!isFinal) {
        // Non-final: notify next approver
        const nextStep = req.approvalChain[req.currentLevel - 1];
        if (!nextStep) return;
        const nextApprover = await this._fetchUserLite(nextStep.approverUserId);
        if (!nextApprover) return;
        const reviewUrl = `${this._getWebAppUrl()}/dashboard/attendance/regularizations/${req._id}`;

        this.notificationsService
          .createNotification(wsId, {
            recipientId: nextApprover._id.toString(),
            title: `Level ${req.currentLevel} approval needed`,
            message: `Regularization for ${member?.name ?? 'a member'} passed level ${req.currentLevel - 1} and needs your review.`,
            type: 'info',
            metadata: {
              entityId: req._id.toString(),
              entityType: 'regularization_request',
            },
          })
          .catch(() => {});

        this.mailService
          .sendRegularizationNextApprover(
            { email: nextApprover.email, name: nextApprover.name },
            {
              level: req.currentLevel,
              memberName: member?.name ?? 'a member',
              date: new Date(req.date).toISOString().slice(0, 10),
              requestedStatus: req.requestedStatus,
              wsName: ws?.name ?? 'Workspace',
              reviewUrl,
            },
          )
          .catch(() => {});
        return;
      }

      // Final approval: notify raiser and member (if member has login and is != raiser)
      const recipients = new Set<string>();
      recipients.add(String(req.raisedBy));
      if (member?.linkedUserId && member.linkedUserId.toString() !== String(req.raisedBy)) {
        recipients.add(member.linkedUserId.toString());
      }

      const viewUrl = `${this._getWebAppUrl()}/dashboard/attendance/regularizations/${req._id}`;

      for (const rid of recipients) {
        const user = await this._fetchUserLite(rid);
        if (!user) continue;

        this.notificationsService
          .createNotification(wsId, {
            recipientId: user._id.toString(),
            title: 'Regularization approved',
            message: `Regularization for ${member?.name ?? 'a member'} on ${new Date(req.date).toISOString().slice(0, 10)} has been approved.`,
            type: 'info',
            metadata: {
              entityId: req._id.toString(),
              entityType: 'regularization_request',
            },
          })
          .catch(() => {});

        this.mailService
          .sendRegularizationApproved(
            { email: user.email, name: user.name },
            {
              memberName: member?.name ?? 'a member',
              date: new Date(req.date).toISOString().slice(0, 10),
              requestedStatus: req.requestedStatus,
              wsName: ws?.name ?? 'Workspace',
              viewUrl,
            },
          )
          .catch(() => {});
      }
    } catch (err: any) {
      this.logger.warn(`notifyAfterApproval failed: ${err?.message}`);
    }
  }

  /** On reject: notify raiser + every approver who already decided. */
  async notifyRejection(wsId: string, req: any): Promise<void> {
    return this._notifyEndDecision(wsId, req, 'rejected');
  }

  /** On cancel: notify raiser + every approver who already decided. */
  async notifyCancellation(wsId: string, req: any): Promise<void> {
    return this._notifyEndDecision(wsId, req, 'cancelled');
  }

  private async _notifyEndDecision(
    wsId: string,
    req: any,
    decisionType: 'rejected' | 'cancelled',
  ): Promise<void> {
    try {
      const ws = await this.workspaceModel.findById(new Types.ObjectId(wsId)).select('name').lean();
      const member = await this.teamMemberModel.findById(req.memberId).select('name').lean();
      const decisionBy = req.approvalChain.find((s: any) => s.decision === decisionType);
      const decisionByUser = decisionBy
        ? await this._fetchUserLite(decisionBy.approverUserId)
        : await this._fetchUserLite(req.raisedBy); // cancel = raiser themselves

      const recipients = new Set<string>();
      recipients.add(String(req.raisedBy));
      for (const step of req.approvalChain) {
        if (step.decision) recipients.add(step.approverUserId.toString());
      }

      const viewUrl = `${this._getWebAppUrl()}/dashboard/attendance/regularizations/${req._id}`;
      const lastNote = req.approvalChain.find((s: any) => s.note)?.note ?? null;

      for (const rid of recipients) {
        const user = await this._fetchUserLite(rid);
        if (!user) continue;

        this.notificationsService
          .createNotification(wsId, {
            recipientId: user._id.toString(),
            title: `Regularization ${decisionType}`,
            message: `Regularization for ${member?.name ?? 'a member'} on ${new Date(req.date).toISOString().slice(0, 10)} was ${decisionType}.`,
            type: 'warning',
            metadata: {
              entityId: req._id.toString(),
              entityType: 'regularization_request',
            },
          })
          .catch(() => {});

        this.mailService
          .sendRegularizationRejected(
            { email: user.email, name: user.name },
            {
              memberName: member?.name ?? 'a member',
              date: new Date(req.date).toISOString().slice(0, 10),
              requestedStatus: req.requestedStatus,
              decisionByName: decisionByUser?.name ?? 'system',
              decisionType,
              note: lastNote,
              wsName: ws?.name ?? 'Workspace',
              viewUrl,
            },
          )
          .catch(() => {});
      }
    } catch (err: any) {
      this.logger.warn(`_notifyEndDecision(${decisionType}) failed: ${err?.message}`);
    }
  }
}
