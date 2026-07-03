import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TeamMember } from '../team/schemas/team-member.schema';
import { CallerScopeService } from '../../common/services/caller-scope.service';

/**
 * SalaryWriteGuardService — Salary hardening (Workstream G, 2026-06-14).
 *
 * Single source for the two cross-cutting WRITE guards every salary mutation
 * must pass. Both were previously either missing or scattered as ad-hoc helpers
 * inside SalaryService; consolidating them here lets LoanService / CommissionService /
 * CashLedgerService / AdvanceSalaryRequestService enforce the exact same rules
 * without re-implementing them (and without a SalaryService cycle — this service
 * only needs CallerScopeService + the TeamMember model).
 *
 * Dependency note:
 *   - reads TeamMember (offboarding flag) — Team module owns the lifecycle flags.
 *   - reads RBAC scope via CallerScopeService (role + per-member overrides).
 *   - written-into by: SalaryService, LoanService, CommissionService,
 *     CashLedgerService, AdvanceSalaryRequestService.
 */
@Injectable()
export class SalaryWriteGuardService {
  constructor(
    @InjectModel(TeamMember.name) private readonly teamModel: Model<TeamMember>,
    private readonly callerScope: CallerScopeService,
  ) {}

  /**
   * OQ-S2 / Playbook Pattern 13 (SoD self-edit block). A non-owner cannot pay,
   * adjust, lock, approve, or otherwise mutate their OWN salary record — even
   * when their grant nominally scopes to `all`. Owner bypasses unconditionally
   * (the workspace owner is the ultimate authority and has no one above them).
   *
   * Mirrors team.service.ts assertNotSelfPrivilegeEdit. `userId` is the acting
   * caller; `targetTeamMemberId` is the member whose money is being touched.
   */
  async assertNotSelfSalaryEdit(
    workspaceId: string,
    userId: string,
    targetTeamMemberId: string,
  ): Promise<void> {
    const ctx = await this.callerScope.resolve(workspaceId, userId);
    if (ctx.isOwner) return;
    if (ctx.teamMemberId && String(ctx.teamMemberId) === String(targetTeamMemberId)) {
      throw new ForbiddenException({
        code: 'SALARY_SELF_EDIT_BLOCKED',
        message: 'You cannot pay or adjust your own salary record (segregation of duties).',
      });
    }
  }

  /**
   * OQ-S5 — write-lock removed-member salary records. Once the TeamMember is
   * soft-deleted (offboarded), retained statutory data becomes READ-ONLY at the
   * moment of removal: any payment / adjustment / loan / commission / ledger
   * write returns 403 MEMBER_OFFBOARDED before mutating, so a removed member's
   * registers can no longer be tampered with. Reads stay open to HR/Owner for
   * statutory export and audit (handled by the read guards, not here).
   *
   * Carve-out (`allowOffboarded`): the F&F flow (initiateFnf / finaliseFnf) and
   * the final-month lock/unlock are themselves the offboarding write, so they
   * remain available to HR/Owner on a removed member. Those call sites pass
   * `{ allowOffboarded: true }` and skip this gate.
   *
   * Fail-closed: a missing member row throws too — a write must never target a
   * member who is not present in this workspace.
   */
  async assertMemberWritable(
    workspaceId: string,
    targetTeamMemberId: string,
    opts?: { allowOffboarded?: boolean },
  ): Promise<void> {
    if (opts?.allowOffboarded) return;
    if (!targetTeamMemberId) {
      throw new ForbiddenException({
        code: 'MEMBER_OFFBOARDED',
        message: 'Salary record has no resolvable team member.',
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
          'This member has been removed. Their salary records are read-only; use Full & Final settlement (HR/Owner) for any closing entries.',
      });
    }
  }
}
