import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Serial, SerialDocument } from './serial.schema';
import { UpdateSerialDto } from './dto/update-serial.dto';

@Injectable()
export class SerialsService {
  constructor(
    @InjectModel(Serial.name)
    private readonly serialModel: Model<SerialDocument>,
  ) {}

  async list(
    workspaceId: string,
    firmId: string,
    filters: { itemId?: string; status?: string; q?: string } = {},
  ): Promise<SerialDocument[]> {
    const q: Record<string, any> = {
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };

    if (filters.itemId) q.itemId = new Types.ObjectId(filters.itemId);
    if (filters.status) q.status = filters.status;
    if (filters.q) {
      // Search by serialNo regex
      q.serialNo = { $regex: filters.q, $options: 'i' };
    }

    return this.serialModel
      .find(q)
      .sort({ createdAt: -1 })
      .lean() as unknown as SerialDocument[];
  }

  async findBySerialNo(
    workspaceId: string,
    firmId: string,
    serialNo: string,
  ): Promise<SerialDocument> {
    const doc = await this.serialModel.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      serialNo,
      isDeleted: false,
    });
    if (!doc) throw new NotFoundException('Serial not found');
    return doc;
  }

  async update(
    workspaceId: string,
    firmId: string,
    serialNo: string,
    dto: UpdateSerialDto,
  ): Promise<SerialDocument> {
    const updateData: Record<string, any> = {};

    if (dto.status !== undefined) {
      updateData.status = dto.status;
      // Audit-aware soft delete: scrapped serials are marked isDeleted
      // but the record stays in registry for traceability
      if (dto.status === 'scrapped') {
        updateData.isDeleted = true;
        updateData.deletedAt = new Date();
      }
      if (dto.status === 'sold') {
        updateData.soldAt = new Date();
      }
    }

    if (dto.currentGodownId !== undefined) {
      updateData.currentGodownId = new Types.ObjectId(dto.currentGodownId);
    }

    const doc = await this.serialModel.findOneAndUpdate(
      {
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        serialNo,
        isDeleted: false,
      },
      { $set: updateData },
      { new: true },
    );
    if (!doc) throw new NotFoundException('Serial not found');
    return doc;
  }
}
