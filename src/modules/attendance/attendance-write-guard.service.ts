import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TeamMember } from '../team/schemas/team-member.schema';
import { CallerScopeService } from '../../common/services/caller-scope.service';

/**
 * AttendanceWriteGuardService — Attendance hardening Pillar 1 + 2 (Workstream G,
 * 2026-06-15). Mirrors SalaryWriteGuardService exactly.
 *
 * Single source for the two cross-cutting WRITE guards every attendance
 * mutation must pass, on top of the existing self-scope and salary-lock guards:
 *
 *   1. assertNotSelfAttendanceEdit — OQ-A3 / Playbook Pattern 13 SoD block. A
 *      non-owner (Manager / HR) cannot mark, edit, or delete their OWN
 *      attendance record even when their grant scopes to `all`. Confirming your
 *      own presence is a conflict of interest in a wage-determination context
 *      (ESI / Gujarat LWF compute pay from attendance), so the audit trail
 *      alone is not enough. Owner bypasses unconditionally.
 *
 *   2. assertMemberWritable — OQ-A5 MEMBER_OFFBOARDED write-lock. Once the
 *      TeamMember is soft-deleted (offboarded), retained statutory attendance
 *      becomes READ-ONLY at the moment of removal (immediately, NOT after a
 *      grace window): any mark / bulk-mark / edit / delete / void / recompute /
 *      self-punch returns 403 MEMBER_OFFBOARDED before mutating, so a removed
 *      member's muster registers can no longer be tampered with. Reads stay
 *      open to HR/Owner/Manager for export and audit.
 *
 * Consolidating both here lets AttendanceService / MeAttendanceService /
 * AttendanceEventService-driven flows enforce the identical rules without
 * re-implementing them, and without a service cycle — this guard only needs
 * CallerScopeService + the TeamMember model.
 *
 * Dependency note:
 *   - reads TeamMember (offboarding flag) — Team module owns the lifecycle flags.
 *   - reads RBAC scope via CallerScopeService (role + per-member overrides).
 *   - written-into by: AttendanceController (mark / bulk / update / delete /
 *     recompute / void) and MeAttendanceController (self-punch).
 */
@Injectable()
export class AttendanceWriteGuardService {
  constructor(
    @InjectModel(TeamMember.name) private readonly teamModel: Model<TeamMember>,
    private readonly callerScope: CallerScopeService,
  ) {}

  /**
   * OQ-A3 / Playbook Pattern 13 (SoD self-edit block). A non-owner cannot act on
   * their OWN attendance record — even when their grant nominally scopes to
   * `all`. Owner bypasses unconditionally (the workspace owner is the ultimate
   * authority and has no one above them).
   *
   * Mirrors SalaryWriteGuardService.assertNotSelfSalaryEdit. `userId` is the
   * acting caller; `targetTeamMemberId` is the member whose attendance is being
   * touched. This is distinct from the existing `assertSelfWriteAllowed`
   * (self-scope guard) which CONFINES a self-scoped Karigar to their own row;
   * this one is the OPPOSITE — it BLOCKS an all-scoped Manager/HR from their own
   * row.
   */
  async assertNotSelfAttendanceEdit(
    workspaceId: string,
    userId: string,
    targetTeamMemberId: string,
  ): Promise<void> {
    if (!targetTeamMemberId) return; // nothing to compare against
    const ctx = await this.callerScope.resolve(workspaceId, userId);
    if (ctx.isOwner) return;
    if (ctx.teamMemberId && String(ctx.teamMemberId) === String(targetTeamMemberId)) {
      throw new ForbiddenException({
        code: 'ATTENDANCE_SELF_EDIT_BLOCKED',
        message:
          'You cannot mark or edit your own attendance record (segregation of duties). Ask the workspace owner or another manager.',
      });
    }
  }

  /**
   * OQ-A5 — write-lock removed-member attendance records. Once the TeamMember is
   * soft-deleted (offboarded), retained statutory data becomes READ-ONLY
   * IMMEDIATELY (no grace window): any mark / edit / delete / void / recompute /
   * self-punch returns 403 MEMBER_OFFBOARDED before mutating. Reads stay open to
   * HR/Owner/Manager for muster export and audit (handled by the read paths, not
   * here).
   *
   * Fail-closed: a missing member row throws too — a write must never target a
   * member who is not present in this workspace (also closes a cross-workspace
   * write, since the filter pins workspaceId).
   */
  async assertMemberWritable(workspaceId: string, targetTeamMemberId: string): Promise<void> {
    if (!targetTeamMemberId) {
      throw new ForbiddenException({
        code: 'MEMBER_OFFBOARDED',
        message: 'Attendance write has no resolvable team member.',
      });
    }
    const member = await this.teamModel
      .findOne({
        _id: new Types.ObjectId(String(targetTeamMemberId)),
        workspaceId: new Types.ObjectId(String(workspaceId)),
      })
      .select('_id isDeleted')
      .lean()
      .exec();
    // No row in this workspace, or the row is soft-deleted → block the write.
    if (!member || member.isDeleted === true) {
      throw new ForbiddenException({
        code: 'MEMBER_OFFBOARDED',
        message:
          'This member has been removed. Their attendance records are read-only and retained for statutory muster registers.',
      });
    }
  }
}
