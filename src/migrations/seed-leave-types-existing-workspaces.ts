import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Workspace } from '../modules/workspaces/schemas/workspace.schema';
import { LeaveType } from '../modules/leave/schemas/leave-type.schema';
import { LEAVE_TYPE_PRESETS } from '../modules/leave/constants/leave-type-presets';

interface MigrationResult {
  workspacesScanned: number;
  leaveTypesCreated: number;
  workspacesSkipped: number;
  errors: string[];
}

/**
 * Leave Management epic L1 (2026-05-16) — backfill the India SMB leave-type
 * preset for every existing workspace so the leave module has a usable
 * catalogue. New workspaces are seeded inline by `WorkspacesService.create`;
 * this run covers any workspace created before L1 shipped.
 *
 * Idempotent — `findOneAndUpdate` upsert keyed on `(workspaceId, code)`. Runs
 * unconditionally on bootstrap (mirrors the W4.11 default-member-role
 * backfill).
 */
@Injectable()
export class SeedLeaveTypesExistingWorkspacesService {
  private readonly logger = new Logger(SeedLeaveTypesExistingWorkspacesService.name);

  constructor(
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    @InjectModel(LeaveType.name)
    private readonly leaveTypeModel: Model<LeaveType>,
  ) {}

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = {
      workspacesScanned: 0,
      leaveTypesCreated: 0,
      workspacesSkipped: 0,
      errors: [],
    };

    const workspaces = await this.workspaceModel.find({}, { _id: 1 }).lean().exec();

    for (const ws of workspaces) {
      result.workspacesScanned++;
      const workspaceId = ws._id;
      let createdHere = 0;

      for (const preset of LEAVE_TYPE_PRESETS) {
        try {
          const existing = await this.leaveTypeModel
            .findOne({ workspaceId, code: preset.code })
            .exec();
          if (existing) continue;

          await this.leaveTypeModel
            .findOneAndUpdate(
              { workspaceId, code: preset.code },
              {
                $setOnInsert: {
                  workspaceId,
                  code: preset.code,
                  labels: preset.labels,
                  color: preset.color,
                  isPaid: preset.isPaid,
                  unit: preset.unit,
                  statutoryBasis: preset.statutoryBasis,
                  maxPerRequest: preset.maxPerRequest,
                  applicability: {
                    gender: preset.applicability.gender,
                    minTenureDays: preset.applicability.minTenureDays,
                    designationIds: [],
                  },
                  accrualRule: preset.accrualRule,
                  yearEndRule: preset.yearEndRule,
                  compOff: preset.compOff,
                  isSystem: preset.isSystem,
                  isActive: true,
                  sortOrder: preset.sortOrder,
                  createdBy: null,
                },
              },
              { upsert: true, new: true, setDefaultsOnInsert: true },
            )
            .exec();
          createdHere++;
          result.leaveTypesCreated++;
        } catch (err) {
          const message = `workspace ${workspaceId.toString()} leave type ${preset.code}: ${
            err instanceof Error ? err.message : String(err)
          }`;
          result.errors.push(message);
          this.logger.warn(`Backfill error — ${message}`);
        }
      }

      if (createdHere === 0) {
        result.workspacesSkipped++;
      }
    }

    return result;
  }
}
