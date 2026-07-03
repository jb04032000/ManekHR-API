import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Workspace } from '../modules/workspaces/schemas/workspace.schema';

interface MigrationResult {
  matched: number;
  modified: number;
}

/**
 * Employee self-service default-on (2026-07-03, owner directive) — flip
 * selfServiceConfig.selfPunch + selfLeaveApply to true on EXISTING workspaces.
 * The Employee baseline role now grants self punch / leave-apply / etc.
 * (migration 0055), but the leave "Apply" button and self check-in are
 * AND-gated on this workspace policy, which defaulted OFF — so the grants were
 * inert. New workspaces now seed both true (workspace.schema.ts defaults).
 *
 * No provenance field distinguishes "never set" from "deliberately disabled";
 * the owner's directive is "default active", so all non-true values flip on
 * (mirrors the 0049 split-payments backfill). Atomic + idempotent: the $ne
 * filters mean a re-run matches nothing. Reversible per workspace via the
 * settings toggle. Links: leave/me page + MyAttendance FE gates,
 * leave-request/comp-off/regularization services (BE gates).
 */
@Injectable()
export class BackfillSelfServiceDefaultOnService {
  private readonly logger = new Logger(BackfillSelfServiceDefaultOnService.name);

  constructor(@InjectModel(Workspace.name) private readonly workspaceModel: Model<Workspace>) {}

  async run(): Promise<MigrationResult> {
    const res = await this.workspaceModel.updateMany(
      {
        $or: [
          { 'selfServiceConfig.selfPunch': { $ne: true } },
          { 'selfServiceConfig.selfLeaveApply': { $ne: true } },
        ],
      },
      {
        $set: {
          'selfServiceConfig.selfPunch': true,
          'selfServiceConfig.selfLeaveApply': true,
        },
      },
    );
    const matched = res.matchedCount ?? 0;
    const modified = res.modifiedCount ?? 0;
    this.logger.log(
      `self-service default-on backfill: matched=${matched} modified=${modified} (existing workspaces enabled)`,
    );
    return { matched, modified };
  }
}
