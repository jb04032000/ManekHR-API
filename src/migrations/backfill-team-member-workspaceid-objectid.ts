import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TeamMember } from '../modules/team/schemas/team-member.schema';

interface MigrationResult {
  scanned: number;
  fixed: number;
  errors: string[];
}

/**
 * Data-integrity fix (2026-05-30). Some TeamMember documents were created with
 * workspaceId stored as a STRING instead of an ObjectId (FK type drift from
 * automated/QA creation). Team queries match workspaceId as an ObjectId only,
 * so these members were invisible and undeletable in the Team module while the
 * salary module - which defensively matches both forms - still listed them,
 * causing a Team/Salary mismatch. Cast every string workspaceId on TeamMember
 * to an ObjectId. Idempotent: a no-op once the data is clean. System-wide
 * (fixes the drift across all workspaces).
 */
@Injectable()
export class BackfillTeamMemberWorkspaceIdObjectIdService {
  private readonly logger = new Logger(BackfillTeamMemberWorkspaceIdObjectIdService.name);

  constructor(@InjectModel(TeamMember.name) private readonly teamModel: Model<TeamMember>) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = { scanned: 0, fixed: 0, errors: [] };

    const stringWsMembers = await this.teamModel
      .find({ workspaceId: { $type: 'string' } } as never)
      .select('_id workspaceId')
      .lean<{ _id: Types.ObjectId; workspaceId: unknown }[]>()
      .exec();

    for (const member of stringWsMembers) {
      result.scanned++;
      try {
        const raw = String(member.workspaceId);
        if (!Types.ObjectId.isValid(raw)) {
          result.errors.push(
            `member ${String(member._id)}: workspaceId "${raw}" is not a valid ObjectId`,
          );
          continue;
        }
        await this.teamModel.updateOne(
          { _id: member._id },
          { $set: { workspaceId: new Types.ObjectId(raw) } },
        );
        result.fixed++;
      } catch (err) {
        result.errors.push(
          `member ${String(member._id)}: ${(err as Error)?.message ?? String(err)}`,
        );
      }
    }

    if (result.fixed > 0 || result.errors.length > 0) {
      this.logger.log(`team-member workspaceId cast: ${JSON.stringify(result)}`);
    }
    return result;
  }
}
