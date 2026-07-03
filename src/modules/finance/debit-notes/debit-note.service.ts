import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { ClientSession, Model, Types } from 'mongoose';
import { DebitNote } from './debit-note.schema';
import { InventoryService } from '../sales/inventory/inventory.service';
import { LineItem } from '../sales/voucher-base/voucher-base.interface';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../common/finance-observability';

/**
 * DebitNoteService — F-07 debit note lifecycle.
 * Inventory integration per F-09-08 (D-11): debit_note_out StockMovement on post.
 */
@Injectable()
export class DebitNoteService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(DebitNote.name) private readonly model: Model<DebitNote>,
    private readonly inventoryService: InventoryService,
    private readonly postHog: PostHogService,
  ) {}

  async findOne(wsId: string, firmId: string, id: string): Promise<DebitNote> {
    const doc = await this.model.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: { $ne: true },
    });
    if (!doc) throw new NotFoundException('DebitNote not found');
    return doc;
  }

  /**
   * Post a DebitNote: stock out via debit_note_out movement for all item lines.
   * Passes full metadata for movement traceability (D-11).
   */
  async post(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
    session?: ClientSession,
  ): Promise<DebitNote> {
    return withFinanceSpan(
      this.tracer,
      'finance.postDebitNoteStock',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const doc = await this.findOne(wsId, firmId, id);
        if ((doc as any).state !== 'draft') {
          throw new BadRequestException('Only draft debit notes can be posted');
        }

        // Build LineItem list for all lines with itemId (skip narration-only lines)
        const stockLines: LineItem[] = ((doc as any).lineItems ?? [])
          .filter((l: any) => l.itemId)
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
          await this.inventoryService.stockOut(wsId, firmId, stockLines, {
            session,
            movementType: 'debit_note_out',
            sourceVoucherId: doc._id.toHexString(),
            sourceVoucherType: 'debit_note',
            sourceVoucherNumber: (doc as any).voucherNumber,
            userId,
          });
        }

        (doc as any).state = 'posted';
        (doc as any).postedAt = new Date();
        (doc as any).postedBy = new Types.ObjectId(userId);
        const saved = await (doc as any).save({ session });
        // Fire-and-forget product analytics on the successful stock-out post (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.posted_debit_note_stock',
          properties: { workspaceId: wsId, firmId, debitNoteId: String(saved._id) },
        });
        return saved;
      },
    );
  }
}
