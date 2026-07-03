import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Lot, LotDocument } from './lot.schema';
import { Item } from '../../items/item.schema';
import { Document } from 'mongoose';
import { LotDailyCounterService } from '../lot-daily-counter/lot-daily-counter.service';
import { StockMovementsService } from '../stock-movements/stock-movements.service';
import { CreateLotDto } from './dto/create-lot.dto';
import { UpdateLotDto } from './dto/update-lot.dto';

type ItemDocument = Item & Document;

@Injectable()
export class LotsService {
  constructor(
    @InjectModel(Lot.name)
    private readonly lotModel: Model<LotDocument>,
    @InjectModel(Item.name)
    private readonly itemModel: Model<ItemDocument>,
    private readonly lotDailyCounter: LotDailyCounterService,
    private readonly stockMovementsService: StockMovementsService,
  ) {}

  async list(
    workspaceId: string,
    firmId: string,
    filters: {
      itemId?: string;
      godownId?: string;
      expiringInDays?: number;
      q?: string;
    } = {},
  ): Promise<LotDocument[]> {
    const q: Record<string, any> = {
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };

    if (filters.itemId) q.itemId = new Types.ObjectId(filters.itemId);
    if (filters.godownId) q.godownId = new Types.ObjectId(filters.godownId);

    if (filters.expiringInDays !== undefined) {
      const cutoff = new Date(
        Date.now() + filters.expiringInDays * 24 * 60 * 60 * 1000,
      );
      q.expiryDate = { $lte: cutoff, $gte: new Date() };
    }

    if (filters.q) {
      q.lotNo = { $regex: filters.q, $options: 'i' };
    }

    return this.lotModel
      .find(q)
      .sort({ inwardDate: -1 })
      .lean() as unknown as LotDocument[];
  }

  async findById(
    workspaceId: string,
    firmId: string,
    id: string,
  ): Promise<LotDocument> {
    const doc = await this.lotModel.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    });
    if (!doc) throw new NotFoundException('Lot not found');
    return doc;
  }

  async create(
    workspaceId: string,
    firmId: string,
    dto: CreateLotDto,
  ): Promise<LotDocument> {
    let lotNo = dto.lotNo;

    // Auto-generate lotNo when not supplied
    if (!lotNo) {
      const item = await this.itemModel
        .findOne({
          _id: new Types.ObjectId(dto.itemId),
          workspaceId: new Types.ObjectId(workspaceId),
          firmId: new Types.ObjectId(firmId),
        })
        .lean();
      if (!item) throw new NotFoundException('Item not found');

      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
      const seq = await this.lotDailyCounter.reserveNextLotSeq(
        workspaceId,
        firmId,
        dto.itemId,
        dateStr,
      );
      const itemCode = (item as any).itemCode ?? dto.itemId.slice(-6);
      lotNo = this.lotDailyCounter.formatLotNo(itemCode, dateStr, seq);
    }

    return this.lotModel.create({
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      itemId: new Types.ObjectId(dto.itemId),
      lotNo,
      inwardDate: new Date(dto.inwardDate),
      expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : undefined,
      mfgDate: dto.mfgDate ? new Date(dto.mfgDate) : undefined,
      supplierId: dto.supplierId
        ? new Types.ObjectId(dto.supplierId)
        : undefined,
      sourceVoucherId: dto.sourceVoucherId
        ? new Types.ObjectId(dto.sourceVoucherId)
        : undefined,
      sourceVoucherType: dto.sourceVoucherType,
      qtyInward: dto.qtyInward,
      qtyRemaining: dto.qtyInward, // initially equal to qtyInward
      weight: dto.weight,
      weightUnit: dto.weightUnit,
      godownId: new Types.ObjectId(dto.godownId),
      remarks: dto.remarks,
      isDeleted: false,
    });
  }

  async update(
    workspaceId: string,
    firmId: string,
    id: string,
    dto: UpdateLotDto,
  ): Promise<LotDocument> {
    // Build update object — never update lotNo or qtyRemaining (managed by stock movement service)
    const updateData: Record<string, any> = {};
    if (dto.itemId !== undefined)
      updateData.itemId = new Types.ObjectId(dto.itemId);
    if (dto.inwardDate !== undefined)
      updateData.inwardDate = new Date(dto.inwardDate);
    if (dto.expiryDate !== undefined)
      updateData.expiryDate = new Date(dto.expiryDate);
    if (dto.mfgDate !== undefined)
      updateData.mfgDate = new Date(dto.mfgDate);
    if (dto.supplierId !== undefined)
      updateData.supplierId = new Types.ObjectId(dto.supplierId);
    if (dto.sourceVoucherId !== undefined)
      updateData.sourceVoucherId = new Types.ObjectId(dto.sourceVoucherId);
    if (dto.sourceVoucherType !== undefined)
      updateData.sourceVoucherType = dto.sourceVoucherType;
    if (dto.qtyInward !== undefined) updateData.qtyInward = dto.qtyInward;
    if (dto.weight !== undefined) updateData.weight = dto.weight;
    if (dto.weightUnit !== undefined) updateData.weightUnit = dto.weightUnit;
    if (dto.godownId !== undefined)
      updateData.godownId = new Types.ObjectId(dto.godownId);
    if (dto.remarks !== undefined) updateData.remarks = dto.remarks;

    const doc = await this.lotModel.findOneAndUpdate(
      {
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      },
      { $set: updateData },
      { new: true },
    );
    if (!doc) throw new NotFoundException('Lot not found');
    return doc;
  }

  /** Soft delete — refused if qtyRemaining > 0 */
  async delete(
    workspaceId: string,
    firmId: string,
    id: string,
  ): Promise<void> {
    const lot = await this.findById(workspaceId, firmId, id);
    if (lot.qtyRemaining > 0) {
      throw new ConflictException(
        `Cannot delete lot: ${lot.qtyRemaining} units still remaining. Consume or transfer all stock first.`,
      );
    }
    await this.lotModel.updateOne(
      { _id: new Types.ObjectId(id) },
      { $set: { isDeleted: true, deletedAt: new Date() } },
    );
  }

  /** Delegate to StockMovementsService — returns movement trail for this lot */
  async findMovements(
    workspaceId: string,
    firmId: string,
    lotId: string,
  ) {
    return this.stockMovementsService.findByLot(workspaceId, firmId, lotId);
  }
}
