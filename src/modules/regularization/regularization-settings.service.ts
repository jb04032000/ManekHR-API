import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DEFAULT_REG_CONFIG } from './regularization.service';
import { UpdateRegularizationConfigDto } from './dto/regularization.dto';

export interface RegularizationConfigView {
  approvalLevels: number;
  maxDaysBack: number;
  fallbackApproverUserId: string | null;
  maxAttachmentsPerRequest: number;
}

/**
 * Read/write workspace.regularizationConfig. Kept separate from
 * RegularizationService (D-04) so the core lifecycle service's scope stays stable.
 *
 * Caps (validated at DTO layer by UpdateRegularizationConfigDto):
 *   approvalLevels in {1,2,3}              per DD-3
 *   maxDaysBack    in [1,90]               per D-01 RegularizationRequest/Workspace schema
 *   maxAttachmentsPerRequest in [0,10]     per D-01 schema
 */
@Injectable()
export class RegularizationSettingsService {
  constructor(
    @InjectModel('Workspace') private readonly workspaceModel: Model<any>,
  ) {}

  async get(wsId: string): Promise<RegularizationConfigView> {
    const wsObjId = new Types.ObjectId(wsId);
    const ws = await this.workspaceModel
      .findById(wsObjId)
      .select('regularizationConfig')
      .lean()
      .exec();
    if (!ws) throw new NotFoundException('Workspace not found');

    const cfg = ws.regularizationConfig ?? {};
    return {
      approvalLevels: cfg.approvalLevels ?? DEFAULT_REG_CONFIG.approvalLevels,
      maxDaysBack: cfg.maxDaysBack ?? DEFAULT_REG_CONFIG.maxDaysBack,
      fallbackApproverUserId: cfg.fallbackApprover
        ? cfg.fallbackApprover.toString()
        : null,
      maxAttachmentsPerRequest:
        cfg.maxAttachmentsPerRequest ??
        DEFAULT_REG_CONFIG.maxAttachmentsPerRequest,
    };
  }

  async update(
    wsId: string,
    dto: UpdateRegularizationConfigDto,
  ): Promise<RegularizationConfigView> {
    const wsObjId = new Types.ObjectId(wsId);
    const fallbackObjId = dto.fallbackApproverUserId
      ? new Types.ObjectId(dto.fallbackApproverUserId)
      : null;

    const updated = await this.workspaceModel
      .findOneAndUpdate(
        { _id: wsObjId },
        {
          $set: {
            regularizationConfig: {
              approvalLevels: dto.approvalLevels,
              maxDaysBack: dto.maxDaysBack,
              fallbackApprover: fallbackObjId,
              maxAttachmentsPerRequest: dto.maxAttachmentsPerRequest,
            },
          },
        },
        { new: true, projection: { regularizationConfig: 1 } },
      )
      .lean()
      .exec();

    if (!updated) throw new NotFoundException('Workspace not found');

    const cfg = updated.regularizationConfig ?? {};
    return {
      approvalLevels: cfg.approvalLevels,
      maxDaysBack: cfg.maxDaysBack,
      fallbackApproverUserId: cfg.fallbackApprover
        ? cfg.fallbackApprover.toString()
        : null,
      maxAttachmentsPerRequest: cfg.maxAttachmentsPerRequest,
    };
  }
}
