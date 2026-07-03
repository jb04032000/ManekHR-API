import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ResourceScope } from './schemas/resource-scope.schema';
import {
  UpsertResourceScopeDto,
  UpdateResourceScopeDto,
} from './dto/resource-scope.dto';

export interface LoadedScope {
  hasScope: boolean;
  isActive: boolean;
  machineIds: Types.ObjectId[];
  locationIds: Types.ObjectId[];
}

@Injectable()
export class ResourceScopesService {
  constructor(
    @InjectModel(ResourceScope.name)
    private readonly scopeModel: Model<ResourceScope>,
  ) {}

  private toObjectId(id: string | Types.ObjectId): Types.ObjectId {
    return typeof id === 'string' ? new Types.ObjectId(id) : id;
  }

  private toIdArray(arr?: string[]): Types.ObjectId[] {
    return (arr ?? []).map((s) => new Types.ObjectId(s));
  }

  private toApi(scope: ResourceScope) {
    const obj = scope.toObject();
    return { ...obj, id: obj._id.toString() };
  }

  /**
   * Guard-friendly loader. Returns a plain shape describing the effective
   * scope for (workspaceId, userId).
   * - hasScope=false  → no row exists; caller treats as unscoped (full).
   * - isActive=false  → row exists but intentionally disabled; unscoped.
   * - otherwise        → apply machineIds + locationIds filters.
   */
  async loadForUser(
    workspaceId: string | Types.ObjectId,
    userId: string | Types.ObjectId,
  ): Promise<LoadedScope> {
    const wsId = this.toObjectId(workspaceId);
    const uId = this.toObjectId(userId);
    const row = await this.scopeModel.findOne({ workspaceId: wsId, userId: uId }).exec();
    if (!row) {
      return {
        hasScope: false,
        isActive: false,
        machineIds: [],
        locationIds: [],
      };
    }
    return {
      hasScope: true,
      isActive: !!row.isActive,
      machineIds: row.machineIds ?? [],
      locationIds: row.locationIds ?? [],
    };
  }

  async findAll(workspaceId: string) {
    const rows = await this.scopeModel
      .find({ workspaceId: this.toObjectId(workspaceId) })
      .populate('userId', 'name email')
      .sort({ createdAt: -1 })
      .exec();
    return rows.map((r) => this.toApi(r));
  }

  async findById(workspaceId: string, scopeId: string) {
    const row = await this.scopeModel
      .findOne({
        _id: this.toObjectId(scopeId),
        workspaceId: this.toObjectId(workspaceId),
      })
      .populate('userId', 'name email')
      .exec();
    if (!row) throw new NotFoundException('Resource scope not found');
    return this.toApi(row);
  }

  async create(
    workspaceId: string,
    creatorUserId: string,
    dto: UpsertResourceScopeDto,
  ) {
    const wsId = this.toObjectId(workspaceId);
    const uId = this.toObjectId(dto.userId);

    const existing = await this.scopeModel
      .findOne({ workspaceId: wsId, userId: uId })
      .exec();
    if (existing) {
      throw new ConflictException(
        'A resource scope already exists for this user. Use PATCH to update.',
      );
    }

    const created = await this.scopeModel.create({
      workspaceId: wsId,
      userId: uId,
      machineIds: this.toIdArray(dto.machineIds),
      locationIds: this.toIdArray(dto.locationIds),
      notes: dto.notes,
      isActive: dto.isActive ?? true,
      createdBy: creatorUserId ? this.toObjectId(creatorUserId) : undefined,
    });
    return this.toApi(created);
  }

  async update(
    workspaceId: string,
    scopeId: string,
    dto: UpdateResourceScopeDto,
  ) {
    const wsId = this.toObjectId(workspaceId);
    const id = this.toObjectId(scopeId);
    const patch: Record<string, unknown> = {};
    if (dto.machineIds !== undefined) {
      patch.machineIds = this.toIdArray(dto.machineIds);
    }
    if (dto.locationIds !== undefined) {
      patch.locationIds = this.toIdArray(dto.locationIds);
    }
    if (dto.notes !== undefined) patch.notes = dto.notes;
    if (dto.isActive !== undefined) patch.isActive = dto.isActive;

    const updated = await this.scopeModel
      .findOneAndUpdate(
        { _id: id, workspaceId: wsId },
        { $set: patch },
        { new: true },
      )
      .exec();
    if (!updated) throw new NotFoundException('Resource scope not found');
    return this.toApi(updated);
  }

  async remove(workspaceId: string, scopeId: string) {
    const result = await this.scopeModel
      .findOneAndDelete({
        _id: this.toObjectId(scopeId),
        workspaceId: this.toObjectId(workspaceId),
      })
      .exec();
    if (!result) throw new NotFoundException('Resource scope not found');
    return { success: true };
  }
}
