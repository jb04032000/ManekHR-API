import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

export interface ResolvedApprover {
  level: number;
  approverUserId: Types.ObjectId;
}

interface ResolveInput {
  wsId: string;
  memberId: string;
  approvalLevels: number;
  fallbackApproverUserId: string | null;
}

@Injectable()
export class RegularizationResolverService {
  private readonly logger = new Logger(RegularizationResolverService.name);

  constructor(
    @InjectModel('TeamMember')
    private readonly teamMemberModel: Model<any>,
  ) {}

  /**
   * Walk TeamMember.reportsTo chain from `memberId` upward, snapshotting the
   * approver User for each level (DD-1). Fills missing levels with
   * `fallbackApproverUserId` (DD-2). Guards against cycles (Pitfall 3).
   *
   * Returns exactly `approvalLevels` entries, or throws if neither the chain
   * nor a fallback can supply enough approvers.
   *
   * NOTE: An approver is the manager's `linkedUserId` (a User), not the
   * TeamMember itself, because RBAC permissions are on Users (assumption A2).
   */
  async resolveApprovers(
    input: ResolveInput,
  ): Promise<ResolvedApprover[]> {
    const { wsId, memberId, approvalLevels, fallbackApproverUserId } = input;

    if (approvalLevels < 1 || approvalLevels > 3) {
      throw new BadRequestException(
        `Invalid approvalLevels=${approvalLevels}; must be 1..3`,
      );
    }

    const wsObjectId = new Types.ObjectId(wsId);
    const chain: ResolvedApprover[] = [];
    const visited = new Set<string>(); // Pitfall 3 cycle guard

    // Start from the requested member. Their reportsTo is the L1 approver's TeamMember.
    let cursorMemberId: Types.ObjectId | null = new Types.ObjectId(memberId);

    for (let level = 1; level <= approvalLevels; level++) {
      if (!cursorMemberId) break;

      const key = cursorMemberId.toString();
      if (visited.has(key)) {
        this.logger.warn(
          `[Resolver] reportsTo cycle detected at member=${key} ws=${wsId} — breaking walk`,
        );
        break;
      }
      visited.add(key);

      // Read the current cursor member to find their reportsTo (wsId-scoped — Pitfall 5)
      const cursor = await this.teamMemberModel
        .findOne({
          _id: cursorMemberId,
          workspaceId: wsObjectId,
          isDeleted: false,
        })
        .select('reportsTo')
        .lean()
        .exec();

      if (!cursor?.reportsTo) break;

      // Resolve the manager's linkedUserId (wsId-scoped — Pitfall 5)
      const manager = await this.teamMemberModel
        .findOne({
          _id: cursor.reportsTo,
          workspaceId: wsObjectId,
          isDeleted: false,
        })
        .select('linkedUserId')
        .lean()
        .exec();

      if (!manager?.linkedUserId) {
        // Manager exists but has no User login — can't approve. Break chain;
        // fallback may fill remaining levels (DD-2).
        this.logger.warn(
          `[Resolver] Manager ${cursor.reportsTo} has no linkedUserId — stopping chain walk`,
        );
        break;
      }

      chain.push({
        level,
        approverUserId: new Types.ObjectId(manager.linkedUserId.toString()),
      });
      cursorMemberId = cursor.reportsTo as Types.ObjectId;
    }

    // Fill missing levels from fallback (DD-2)
    if (fallbackApproverUserId) {
      for (let level = chain.length + 1; level <= approvalLevels; level++) {
        chain.push({
          level,
          approverUserId: new Types.ObjectId(fallbackApproverUserId),
        });
      }
    }

    if (chain.length < approvalLevels) {
      throw new BadRequestException(
        'APPROVAL_CHAIN_INCOMPLETE: reportsTo chain is too short AND no fallbackApprover is configured. Configure workspace.regularizationConfig.fallbackApprover or assign reportsTo on the employee/managers.',
      );
    }

    return chain;
  }
}
