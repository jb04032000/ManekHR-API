import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { isWorkspaceOwner } from '../../../../common/utils/workspace-ownership.util';
import { applyPathOverrides } from '../../../../modules/rbac/permission-path-overrides';
import { pathGrantSatisfies } from '../../../../modules/rbac/permission-matcher';

/**
 * PurchaseBillPolicyService — resolves whether a caller is EXEMPT from the
 * maker-checker / four-eyes block on PurchaseBill posting (Finance/Bills
 * hardening OQ-FB-5).
 *
 * Owner / HR are exempt; a Manager is not. We resolve this read-only, mirroring
 * the RolesGuard caller-resolution chain:
 *   - workspace owner → exempt (short-circuit);
 *   - else the caller's effective permissionPaths (role + per-member path
 *     overrides) must include `finance.settings.manage`, which is the HR/Owner-
 *     only sentinel (the Manager preset deliberately omits it, mirroring how
 *     attendance.policy.manage is HR-only). A Manager therefore lacks it and is
 *     subject to the four-eyes block; HR holds it and is exempt.
 *
 * Fail-CLOSED on any lookup miss: returns false (NOT exempt) so the four-eyes
 * block stays in force when it is enabled. Reads only workspaces / members /
 * roles / team-members (by name token); no cross-module write.
 */
@Injectable()
export class PurchaseBillPolicyService {
  constructor(
    @InjectModel('Workspace') private readonly workspaceModel: Model<any>,
    @InjectModel('WorkspaceMember') private readonly memberModel: Model<any>,
    @InjectModel('Role') private readonly roleModel: Model<any>,
    @InjectModel('TeamMember') private readonly teamMemberModel: Model<any>,
  ) {}

  async isExemptFromMakerChecker(workspaceId: string, userId: string): Promise<boolean> {
    try {
      const ws = await this.workspaceModel.findById(workspaceId).lean().exec();
      if (!ws || ws.isDeleted === true) return false;
      if (isWorkspaceOwner(ws, userId)) return true;

      const member = await this.memberModel
        .findOne({
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          userId: new mongoose.Types.ObjectId(userId),
          status: 'active',
        })
        .lean()
        .exec();
      if (!member?.roleId) return false;

      const role = await this.roleModel
        .findOne({ _id: new mongoose.Types.ObjectId(String(member.roleId)) })
        .lean()
        .exec();
      if (!role) return false;

      const teamMember = await this.teamMemberModel
        .findOne({
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          linkedUserId: new mongoose.Types.ObjectId(userId),
          isDeleted: false,
        })
        .select('permissionPathOverrides')
        .lean()
        .exec();

      const grantedPaths = applyPathOverrides(
        role.permissionPaths ?? [],
        teamMember?.permissionPathOverrides ?? [],
      );
      // HR/Owner sentinel — Manager does NOT hold finance.settings.manage.
      return pathGrantSatisfies(grantedPaths, {
        path: 'finance.settings.manage',
        scope: 'all',
      });
    } catch {
      return false;
    }
  }
}
