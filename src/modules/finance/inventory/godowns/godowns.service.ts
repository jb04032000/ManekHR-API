import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Godown, GodownDocument } from './godown.schema';
import { GodownBalanceService } from '../godown-balances/godown-balance.service';
import { WorkspaceCounterService } from '../../../workspaces/workspace-counter.service';
import { CreateGodownDto } from './dto/create-godown.dto';
import { UpdateGodownDto } from './dto/update-godown.dto';

@Injectable()
export class GodownsService {
  constructor(
    @InjectModel(Godown.name)
    private readonly godownModel: Model<GodownDocument>,
    private readonly counterService: WorkspaceCounterService,
    private readonly balanceService: GodownBalanceService,
  ) {}

  /**
   * Called by FirmsService.create() AND InventoryMigrationService.seedMainGodownForAllFirms()
   * Idempotent — returns existing default godown if already seeded.
   */
  async seedMainGodown(
    workspaceId: string,
    firmId: string,
  ): Promise<GodownDocument> {
    const existing = await this.godownModel.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDefault: true,
      isDeleted: false,
    });
    if (existing) return existing;

    const seq = await this.counterService.reserveNextGodownCode(workspaceId);
    return this.godownModel.create({
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      name: 'Main Godown',
      code: `GDN-${String(seq).padStart(3, '0')}`,
      isDefault: true,
      isActive: true,
      isDeleted: false,
    });
  }

  async list(
    workspaceId: string,
    firmId: string,
  ): Promise<GodownDocument[]> {
    return this.godownModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .sort({ isDefault: -1, code: 1 })
      .lean() as unknown as GodownDocument[];
  }

  async findById(
    workspaceId: string,
    firmId: string,
    id: string,
  ): Promise<GodownDocument> {
    const doc = await this.godownModel.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    });
    if (!doc) throw new NotFoundException('Godown not found');
    return doc;
  }

  async create(
    workspaceId: string,
    firmId: string,
    dto: CreateGodownDto,
  ): Promise<GodownDocument> {
    const seq = await this.counterService.reserveNextGodownCode(workspaceId);

    // If isDefault=true and another default exists, demote the existing default
    if (dto.isDefault) {
      await this.godownModel.updateMany(
        {
          workspaceId: new Types.ObjectId(workspaceId),
          firmId: new Types.ObjectId(firmId),
          isDefault: true,
        },
        { $set: { isDefault: false } },
      );
    }

    return this.godownModel.create({
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      ...dto,
      code: `GDN-${String(seq).padStart(3, '0')}`,
      isDefault: dto.isDefault ?? false,
      isActive: true,
      isDeleted: false,
    });
  }

  async update(
    workspaceId: string,
    firmId: string,
    id: string,
    dto: UpdateGodownDto,
  ): Promise<GodownDocument> {
    if (dto.isDefault === true) {
      // Demote any other default godown for this firm
      await this.godownModel.updateMany(
        {
          workspaceId: new Types.ObjectId(workspaceId),
          firmId: new Types.ObjectId(firmId),
          isDefault: true,
          _id: { $ne: new Types.ObjectId(id) },
        },
        { $set: { isDefault: false } },
      );
    }

    const doc = await this.godownModel.findOneAndUpdate(
      {
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      },
      { $set: dto },
      { new: true },
    );
    if (!doc) throw new NotFoundException('Godown not found');
    return doc;
  }

  /**
   * Soft delete with guard: cannot delete if any GodownBalance has non-zero qty.
   * Cannot delete the default godown.
   */
  async delete(
    workspaceId: string,
    firmId: string,
    id: string,
  ): Promise<void> {
    const godown = await this.findById(workspaceId, firmId, id);

    if (godown.isDefault) {
      throw new ConflictException(
        'Cannot delete the default godown. Set another godown as default first.',
      );
    }

    const balances = await this.balanceService.listForGodown(
      workspaceId,
      firmId,
      id,
    );
    const nonZeroCount = balances.filter((b) => b.qty !== 0).length;
    if (nonZeroCount > 0) {
      throw new ConflictException(
        `Cannot delete godown: contains stock in ${nonZeroCount} item(s). Transfer all stock to another godown first.`,
      );
    }

    await this.godownModel.updateOne(
      { _id: new Types.ObjectId(id) },
      { $set: { isDeleted: true, deletedAt: new Date(), isActive: false } },
    );
  }
}
