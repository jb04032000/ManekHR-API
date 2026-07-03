import { ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { AssetCategory } from './asset-category.schema';
import { CreateAssetCategoryDto } from './dto/create-asset-category.dto';
import { UpdateAssetCategoryDto } from './dto/update-asset-category.dto';

@Injectable()
export class AssetCategoryService {
  constructor(
    @InjectModel(AssetCategory.name) private readonly model: Model<AssetCategory>,
  ) {}

  async list(wsId: string, firmId: string) {
    return this.model
      .find({
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .sort({ isSystem: -1, name: 1 })
      .exec();
  }

  async findOne(wsId: string, firmId: string, id: string) {
    const doc = await this.model.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    }).exec();
    if (!doc) throw new NotFoundException('Asset category not found');
    return doc;
  }

  async create(wsId: string, firmId: string, dto: CreateAssetCategoryDto, userId: string) {
    try {
      return await this.model.create({
        ...dto,
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        createdBy: userId ? new Types.ObjectId(userId) : undefined,
        isSystem: false,
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new HttpException('Category with this name already exists', HttpStatus.CONFLICT);
      }
      throw err;
    }
  }

  async update(wsId: string, firmId: string, id: string, dto: UpdateAssetCategoryDto) {
    const doc = await this.findOne(wsId, firmId, id);
    if (doc.isSystem && (dto.depreciationMethod || dto.slmRate !== undefined || dto.wdvRate !== undefined)) {
      throw new ForbiddenException('System category rates cannot be changed; clone it instead');
    }
    Object.assign(doc, dto);
    await doc.save();
    return doc;
  }

  async softDelete(wsId: string, firmId: string, id: string) {
    const doc = await this.findOne(wsId, firmId, id);
    if (doc.isSystem) throw new ForbiddenException('System categories cannot be deleted');
    doc.isDeleted = true;
    doc.deletedAt = new Date();
    await doc.save();
    return { ok: true };
  }

  /**
   * Idempotent seed of default Schedule II categories for a newly-created firm.
   * Safe to call multiple times — uses upsert on (firmId, name).
   */
  async seedDefaults(wsId: string, firmId: string): Promise<number> {
    const seedPath = path.join(__dirname, 'seeds', 'default-categories.json');
    const seedJson: any[] = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    let count = 0;
    for (const entry of seedJson) {
      const result = await this.model.updateOne(
        {
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          name: entry.name,
        },
        {
          $setOnInsert: {
            ...entry,
            workspaceId: new Types.ObjectId(wsId),
            firmId: new Types.ObjectId(firmId),
            isSystem: true,
            isDeleted: false,
          },
        },
        { upsert: true },
      );
      // Only increment when a document was actually inserted (not a no-op re-seed)
      if (result.upsertedCount > 0) count++;
    }
    return count;
  }
}
