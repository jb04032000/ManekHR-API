import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Attendance } from './schemas/attendance.schema';
import { AttendanceEvent } from './schemas/attendance-event.schema';
import { TeamMember } from '../team/schemas/team-member.schema';
import { AuditService } from '../audit/audit.service';
import { AppModule } from '../../common/enums/modules.enum';

/**
 * AttendanceLifecycleService — Attendance hardening Pillar 1 (Workstream G,
 * 2026-06-15). Mirrors SalaryLifecycleService exactly so the Team removal
 * cascade drives both modules through one identical shape.
 *
 * Two public methods:
 *
 *  - memberHasHistory(): the attendance-side gate behind the Remove-vs-Delete
 *    policy (DATA-MAP §1b, OQ-A1). Returns true if the member has ANY
 *    Attendance projection row OR any AttendanceEvent (the immutable punch
 *    stream). A member who punched in even once owns muster-roll evidence that
 *    is statutory under ESI / Gujarat LWF and MUST NOT be hard-deleted; the
 *    Team permanent-delete gate consults this alongside the salary gate.
 *
 *  - onMemberRemoved(): the attendance-side cascade fired by TeamService.remove()
 *    when a member is soft-deleted. It does NOT delete any Attendance /
 *    AttendanceEvent row (Bucket B, retained 10y, see DATA-MAP-AND-RETENTION).
 *    It performs only the IMMEDIATE security-credential scrub (OQ-A6 → B):
 *    clear kioskPinHash / kioskLockedUntil / kioskFailedAttempts on the
 *    TeamMember row right away (before any Bucket-C grace window), because the
 *    kiosk PIN is a physical-access credential and a removed employee must not
 *    retain a working tablet PIN even for the grace window. The kiosk service
 *    already guards `isDeleted:false`, so this is defense-in-depth on top of
 *    that guard, not the only line of protection.
 *
 * The write-lock that makes a removed member's attendance read-only is enforced
 * at REQUEST time by AttendanceWriteGuardService.assertMemberWritable (the
 * MEMBER_OFFBOARDED gate), exactly like the salary write guard — there is no
 * stored "locked" flag to register here.
 *
 * Dependency note:
 *   - reads its own Attendance / AttendanceEvent collections (history probe);
 *   - WRITES the Team-owned TeamMember kiosk-credential fields (the Attendance
 *     module is the only writer of those fields — kiosk PIN set / lockout — so
 *     it owns clearing them too; the Team module's Bucket-C scrub does NOT touch
 *     them, see OQ-A6);
 *   - Team module CALLS onMemberRemoved + memberHasHistory via moduleRef across
 *     the TeamModule<->AttendanceModule forwardRef cycle. Both are wired through
 *     AttendanceModule's export of AttendanceLifecycleService.
 *   - audits via AuditService.
 */
@Injectable()
export class AttendanceLifecycleService {
  private readonly logger = new Logger(AttendanceLifecycleService.name);

  constructor(
    @InjectModel(Attendance.name) private readonly attendanceModel: Model<Attendance>,
    @InjectModel(AttendanceEvent.name) private readonly eventModel: Model<AttendanceEvent>,
    @InjectModel(TeamMember.name) private readonly teamModel: Model<TeamMember>,
    private readonly auditService: AuditService,
  ) {}

  /**
   * DATA-MAP §3 / OQ-A1 (attendance-specific). A member HAS attendance history
   * if a daily Attendance projection row OR a raw AttendanceEvent exists for
   * (workspaceId, teamMemberId). If true, the Team permanent-delete MUST be
   * converted to "remove/offboard" — the muster roll is statutory evidence.
   *
   * Cheap: two indexed `exists` probes that short-circuit on the first hit.
   * NOTE the two collections use different workspace-FK field names —
   * Attendance.workspaceId vs AttendanceEvent.wsId — so each probe carries its
   * own filter shape.
   */
  async memberHasHistory(workspaceId: string, teamMemberId: string): Promise<boolean> {
    const ws = new Types.ObjectId(String(workspaceId));
    const tm = new Types.ObjectId(String(teamMemberId));

    // Daily projection row first (one per member-day; most members have many).
    const hasAttendance = await this.attendanceModel.exists({ workspaceId: ws, teamMemberId: tm });
    if (hasAttendance) return true;

    // Raw punch-event stream (wsId, not workspaceId — see schema). A member with
    // events but no projection row is rare but possible (e.g. only voided punches),
    // so this is checked explicitly rather than relying on the projection alone.
    const hasEvent = await this.eventModel.exists({ wsId: ws, teamMemberId: tm });
    return !!hasEvent;
  }

  /**
   * Attendance-side cascade for member removal (DATA-MAP §4 step 3, OQ-A6 → B).
   * Idempotent and non-fatal: a failure here must never block the Team-side
   * soft-delete, so the caller wraps it best-effort. No Attendance /
   * AttendanceEvent row is deleted.
   *
   * Action: IMMEDIATELY clear the kiosk physical-access credential on the
   * TeamMember row (kioskPinHash + lockout state). Done before any Bucket-C
   * grace window because the PIN is a credential, not basis-less profile PII.
   */
  async onMemberRemoved(
    workspaceId: string,
    teamMemberId: string,
    actorId: string,
  ): Promise<{ kioskCredentialCleared: boolean }> {
    const ws = new Types.ObjectId(String(workspaceId));
    const tm = new Types.ObjectId(String(teamMemberId));

    // OQ-A6 → B: clear the kiosk PIN hash + lockout counters immediately. The
    // Attendance module owns these fields (it is the only writer), so it owns
    // clearing them. Only clear when something is actually set so the result
    // flag is meaningful and we avoid a no-op write churn.
    const clearRes = await this.teamModel
      .updateOne(
        {
          _id: tm,
          workspaceId: ws,
          $or: [
            { kioskPinHash: { $ne: null } },
            { kioskLockedUntil: { $ne: null } },
            { kioskFailedAttempts: { $gt: 0 } },
          ],
        },
        {
          $set: { kioskPinHash: null, kioskLockedUntil: null, kioskFailedAttempts: 0 },
        },
      )
      .exec();

    const kioskCredentialCleared = (clearRes.modifiedCount ?? 0) > 0;

    try {
      await this.auditService.logEvent({
        workspaceId,
        module: AppModule.ATTENDANCE,
        entityType: 'team_member',
        entityId: String(teamMemberId),
        action: 'attendance.member_removed_cascade',
        actorId,
        teamMemberId: String(teamMemberId),
        meta: { kioskCredentialCleared },
      });
    } catch (err) {
      // Non-fatal: an audit failure must not abort removal.
      this.logger.warn(
        `onMemberRemoved audit failed ws=${workspaceId} member=${teamMemberId}: ${
          (err as Error)?.message ?? err
        }`,
      );
    }

    this.logger.log(
      `attendance onMemberRemoved ws=${workspaceId} member=${teamMemberId} ` +
        `kioskCredentialCleared=${kioskCredentialCleared}`,
    );

    return { kioskCredentialCleared };
  }
}
