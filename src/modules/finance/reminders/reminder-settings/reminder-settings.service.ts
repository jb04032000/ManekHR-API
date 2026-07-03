import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ReminderSettings } from './reminder-settings.schema';
import { UpdateReminderSettingsDto } from './reminder-settings.dto';

@Injectable()
export class ReminderSettingsService {
  constructor(
    @InjectModel(ReminderSettings.name) private readonly model: Model<ReminderSettings>,
  ) {}

  async getOrCreate(workspaceId: string, firmId: string): Promise<ReminderSettings> {
    return this.model.findOneAndUpdate(
      {
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
      },
      {
        $setOnInsert: {
          workspaceId: new Types.ObjectId(workspaceId),
          firmId: new Types.ObjectId(firmId),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();
  }

  async update(workspaceId: string, firmId: string, dto: UpdateReminderSettingsDto): Promise<ReminderSettings> {
    const updatePayload: Record<string, any> = { ...dto };
    if (dto.optOutPartyIds) {
      updatePayload.optOutPartyIds = dto.optOutPartyIds.map((id) => new Types.ObjectId(id));
    }
    return this.model.findOneAndUpdate(
      {
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
      },
      { $set: updatePayload },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).exec();
  }
}
