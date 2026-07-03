import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { LeaveType } from './schemas/leave-type.schema';
import { LEAVE_TYPE_PRESETS } from './constants/leave-type-presets';

interface SeedResult {
  created: string[]; // leave-type codes
  skipped: string[];
}

/**
 * Seeds the India SMB leave-type preset for a workspace. Called on
 * `workspace.create` + by the bootstrap migration for existing workspaces.
 *
 * Idempotent + race-safe: `findOneAndUpdate` with `$setOnInsert` keyed on
 * `(workspaceId, code)` so concurrent boot + workspace-create paths converge
 * on a single row. Mirrors `RoleSeederService`.
 */
@Injectable()
export class LeaveTypeSeederService {
  private readonly logger = new Logger(LeaveTypeSeederService.name);

  constructor(
    @InjectModel(LeaveType.name)
    private readonly leaveTypeModel: Model<LeaveType>,
  ) {}

  async seedDefaultLeaveTypesForWorkspace(workspaceId: string): Promise<SeedResult> {
    const result: SeedResult = { created: [], skipped: [] };
    const wsObjectId = new Types.ObjectId(workspaceId);

    for (const preset of LEAVE_TYPE_PRESETS) {
      try {
        const existing = await this.leaveTypeModel
          .findOne({ workspaceId: wsObjectId, code: preset.code })
          .exec();
        if (existing) {
          result.skipped.push(preset.code);
          continue;
        }

        await this.leaveTypeModel
          .findOneAndUpdate(
            { workspaceId: wsObjectId, code: preset.code },
            {
              $setOnInsert: {
                workspaceId: wsObjectId,
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
        result.created.push(preset.code);
      } catch (err) {
        this.logger.error(
          `seed leave type ${preset.code} failed for workspace=${workspaceId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }

    return result;
  }
}
