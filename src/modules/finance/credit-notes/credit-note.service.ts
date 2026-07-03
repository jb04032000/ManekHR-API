import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { CreditNote } from './credit-note.schema';
import { InventoryService } from '../sales/inventory/inventory.service';
import { LineItem } from '../sales/voucher-base/voucher-base.interface';

/**
 * CreditNoteService — F-07 credit note lifecycle.
 * Inventory integration per F-09-08 (D-11): credit_note_in StockMovement on post.
 */
@Injectable()
export class CreditNoteService {
  constructor(
    @InjectModel(CreditNote.name) private readonly model: Model<CreditNote>,
    private readonly inventoryService: InventoryService,
  ) {}

  async findOne(wsId: string, firmId: string, id: string): Promise<CreditNote> {
    const doc = await this.model.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: { $ne: true },
    });
    if (!doc) throw new NotFoundException('CreditNote not found');
    return doc;
  }

  /**
   * Post a CreditNote: reverse stock in via credit_note_in movement for lines
   * where reverseStock=true. Passes full metadata for movement traceability (D-11).
   */
  async post(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
    session?: ClientSession,
  ): Promise<CreditNote> {
    const doc = await this.findOne(wsId, firmId, id);
    if ((doc as any).state !== 'draft') {
      throw new BadRequestException('Only draft credit notes can be posted');
    }

    // Build LineItem list for lines that have reverseStock=true (selective reversal)
    const stockLines: LineItem[] = ((doc as any).lineItems ?? [])
      .filter((l: any) => l.reverseStock && l.itemId)
      .map((l: any) => ({
        itemId: l.itemId,
        itemName: l.itemName ?? '',
        qty: l.qty ?? 0,
        unit: l.unit ?? '',
        ratePaise: l.ratePaise ?? 0,
        discountPct: l.discountPct ?? 0,
        taxRate: l.taxRate ?? 0,
        isTaxInclusive: false,
        godownId: l.godownId?.toString(),
        lotId: l.lotId?.toString(),
        batchId: l.batchId?.toString(),
        serialNos: l.serialNos,
      }));

    if (stockLines.length > 0) {
      await this.inventoryService.stockIn(wsId, firmId, stockLines, {
        session,
        movementType: 'credit_note_in',
        sourceVoucherId: (doc._id as Types.ObjectId).toHexString(),
        sourceVoucherType: 'credit_note',
        sourceVoucherNumber: (doc as any).voucherNumber,
        userId,
      });
    }

    (doc as any).state = 'posted';
    (doc as any).postedAt = new Date();
    (doc as any).postedBy = new Types.ObjectId(userId);
    return (doc as any).save({ session });
  }
}
