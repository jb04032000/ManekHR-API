import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Item } from './item.schema';

@Injectable()
export class ItemsService {
  constructor(@InjectModel(Item.name) private readonly model: Model<Item>) {}

  async create(workspaceId: string, firmId: string, dto: any): Promise<Item> {
    const doc = new this.model({
      ...dto,
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
    });
    return doc.save();
  }

  async findAll(workspaceId: string, firmId: string): Promise<Item[]> {
    return this.model
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .sort({ name: 1 })
      .exec();
  }

  async findOne(workspaceId: string, firmId: string, itemId: string): Promise<Item> {
    const doc = await this.model.findOne({
      _id: new Types.ObjectId(itemId),
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    }).exec();
    if (!doc) throw new NotFoundException('Item not found');
    return doc;
  }

  async update(workspaceId: string, firmId: string, itemId: string, dto: any): Promise<Item> {
    const doc = await this.model.findOneAndUpdate(
      {
        _id: new Types.ObjectId(itemId),
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      },
      { $set: dto },
      { new: true },
    ).exec();
    if (!doc) throw new NotFoundException('Item not found');
    return doc;
  }

  async remove(workspaceId: string, firmId: string, itemId: string): Promise<void> {
    const result = await this.model.updateOne(
      {
        _id: new Types.ObjectId(itemId),
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      },
      { isDeleted: true, deletedAt: new Date() },
    ).exec();
    if (result.matchedCount === 0) throw new NotFoundException('Item not found');
  }
}
