import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { Batch, BatchDocument } from './batch.schema';
import { CreateBatchDto } from './dto/create-batch.dto';
import { PartialType } from '@nestjs/mapped-types';

// Inline UpdateBatchDto to avoid extra file (plan only specifies one DTO for batches)
class UpdateBatchDto extends PartialType(CreateBatchDto) {}

@Injectable()
export class BatchesService {
  constructor(
    @InjectModel(Batch.name)
    private readonly batchModel: Model<BatchDocument>,
  ) {}

  async list(
    workspaceId: string,
    firmId: string,
    filters: { itemId?: string; godownId?: string } = {},
  ): Promise<BatchDocument[]> {
    const q: Record<string, any> = {
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };
    if (filters.itemId) q.itemId = new Types.ObjectId(filters.itemId);
    if (filters.godownId) q.godownId = new Types.ObjectId(filters.godownId);

    return this.batchModel
      .find(q)
      .sort({ createdAt: -1 })
      .lean() as unknown as BatchDocument[];
  }

  async findById(
    workspaceId: string,
    firmId: string,
    id: string,
  ): Promise<BatchDocument> {
    const doc = await this.batchModel.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    });
    if (!doc) throw new NotFoundException('Batch not found');
    return doc;
  }

  async create(
    workspaceId: string,
    firmId: string,
    dto: CreateBatchDto,
    session?: ClientSession,
  ): Promise<BatchDocument> {
    const docs = await this.batchModel.create(
      [
        {
          workspaceId: new Types.ObjectId(workspaceId),
          firmId: new Types.ObjectId(firmId),
          itemId: new Types.ObjectId(dto.itemId),
          batchNo: dto.batchNo,
          mfgDate: dto.mfgDate ? new Date(dto.mfgDate) : undefined,
          expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : undefined,
          bomId: (dto as any).bomId ? new Types.ObjectId((dto as any).bomId) : undefined,
          qtyProduced: dto.qtyProduced,
          qtyRemaining: dto.qtyProduced,
          godownId: new Types.ObjectId(dto.godownId),
          isDeleted: false,
        },
      ],
      session ? { session } : undefined,
    );
    return docs[0];
  }

  async update(
    workspaceId: string,
    firmId: string,
    id: string,
    dto: Partial<CreateBatchDto> & { mfgDate?: string | Date; qtyRemaining?: number; bomId?: string },
    session?: ClientSession,
  ): Promise<BatchDocument> {
    const updateData: Record<string, any> = {};
    if (dto.itemId !== undefined)
      updateData.itemId = new Types.ObjectId(dto.itemId);
    if (dto.batchNo !== undefined) updateData.batchNo = dto.batchNo;
    if (dto.mfgDate !== undefined)
      updateData.mfgDate = new Date(dto.mfgDate);
    if (dto.expiryDate !== undefined)
      updateData.expiryDate = new Date(dto.expiryDate);
    if (dto.qtyProduced !== undefined)
      updateData.qtyProduced = dto.qtyProduced;
    if (dto.qtyRemaining !== undefined) updateData.qtyRemaining = dto.qtyRemaining;
    if ((dto as any).bomId !== undefined) updateData.bomId = new Types.ObjectId((dto as any).bomId);
    if (dto.godownId !== undefined)
      updateData.godownId = new Types.ObjectId(dto.godownId);

    const doc = await this.batchModel.findOneAndUpdate(
      {
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      },
      { $set: updateData },
      { new: true, session },
    );
    if (!doc) throw new NotFoundException('Batch not found');
    return doc;
  }

  /**
   * Soft-delete without the qtyRemaining guard.
   *
   * Used by F-10 ManufacturingVoucherService.cancel when a production batch must be
   * rolled back (qtyProduced = 0 at that point, so the user-facing guard in delete()
   * would pass, but we want an explicit separate method for transactional use).
   */
  async softDelete(
    workspaceId: string,
    firmId: string,
    id: string,
    session?: ClientSession,
  ): Promise<void> {
    await this.batchModel.updateOne(
      {
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
      },
      { $set: { isDeleted: true, deletedAt: new Date() } },
      session ? { session } : undefined,
    );
  }

  /** Soft delete — refused if qtyRemaining > 0 */
  async delete(
    workspaceId: string,
    firmId: string,
    id: string,
  ): Promise<void> {
    const batch = await this.findById(workspaceId, firmId, id);
    if (batch.qtyRemaining > 0) {
      throw new ConflictException(
        `Cannot delete batch: ${batch.qtyRemaining} units still remaining.`,
      );
    }
    await this.batchModel.updateOne(
      { _id: new Types.ObjectId(id) },
      { $set: { isDeleted: true, deletedAt: new Date() } },
    );
  }
}
