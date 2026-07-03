import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ReminderRule } from './reminder-rule.schema';
import { CreateReminderRuleDto, ListRulesQueryDto, UpdateReminderRuleDto } from './reminder-rule.dto';

@Injectable()
export class ReminderRulesService {
  constructor(
    @InjectModel(ReminderRule.name) private readonly model: Model<ReminderRule>,
  ) {}

  async create(workspaceId: string, firmId: string, dto: CreateReminderRuleDto): Promise<ReminderRule> {
    return new this.model({
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      ...dto,
      partyId: dto.partyId ? new Types.ObjectId(dto.partyId) : undefined,
    }).save();
  }

  async list(workspaceId: string, firmId: string, query: ListRulesQueryDto): Promise<ReminderRule[]> {
    const filter: Record<string, any> = {
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };
    if (query.triggerType !== undefined) filter.triggerType = query.triggerType;
    if (query.partyId !== undefined) filter.partyId = new Types.ObjectId(query.partyId);
    if (query.isActive !== undefined) filter.isActive = query.isActive;
    return this.model.find(filter).sort({ priority: -1, createdAt: -1 }).exec();
  }

  async get(workspaceId: string, firmId: string, ruleId: string): Promise<ReminderRule> {
    const rule = await this.model.findOne({
      _id: new Types.ObjectId(ruleId),
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    }).exec();
    if (!rule) throw new NotFoundException(`ReminderRule ${ruleId} not found`);
    return rule;
  }

  async update(workspaceId: string, firmId: string, ruleId: string, dto: UpdateReminderRuleDto): Promise<ReminderRule> {
    const updatePayload: Record<string, any> = { ...dto };
    if (dto.partyId) updatePayload.partyId = new Types.ObjectId(dto.partyId);
    const updated = await this.model.findOneAndUpdate(
      {
        _id: new Types.ObjectId(ruleId),
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      },
      { $set: updatePayload },
      { new: true },
    ).exec();
    if (!updated) throw new NotFoundException(`ReminderRule ${ruleId} not found`);
    return updated;
  }

  async softDelete(workspaceId: string, firmId: string, ruleId: string): Promise<void> {
    const updated = await this.model.findOneAndUpdate(
      {
        _id: new Types.ObjectId(ruleId),
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      },
      { $set: { isDeleted: true, deletedAt: new Date() } },
      { new: true },
    ).exec();
    if (!updated) throw new NotFoundException(`ReminderRule ${ruleId} not found`);
  }

  async findApplicableRules(params: {
    workspaceId: string;
    firmId: string;
    partyId: string;
    triggerType: string;
  }): Promise<ReminderRule[]> {
    return this.model.find({
      workspaceId: new Types.ObjectId(params.workspaceId),
      firmId: new Types.ObjectId(params.firmId),
      isDeleted: false,
      isActive: true,
      triggerType: params.triggerType,
      $or: [
        { partyId: new Types.ObjectId(params.partyId) },
        { partyId: null },
        { partyId: { $exists: false } },
      ],
    }).sort({ priority: -1 }).exec();
  }
}
