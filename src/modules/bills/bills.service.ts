import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Bill } from './schemas/bill.schema';
import { CreateBillDto, UpdateBillDto, RecordBillPaymentDto } from './dto/bill.dto';
import { UploadsService } from '../uploads/uploads.service';
import { AuditService } from '../audit/audit.service';
import { AppModule } from '../../common/enums/modules.enum';

/**
 * BillsService — legacy AP/AR tracker.
 *
 * Finance/Bills hardening (2026-06-15) reworked this service to treat a Bill as
 * a statutory financial record:
 *   - remove() is a SOFT-delete (never the old findOneAndDelete hard-erase);
 *     the invoice file is NOT deleted (Bucket B evidence, 8y retention).
 *   - all reads exclude `{ isDeleted: false }` so deleted bills disappear from
 *     every list / get / count.
 *   - update() blocks replacing the invoice on a PAID bill (D1: a settled
 *     invoice is evidence) except for an Owner/HR override, which is audited.
 *   - create / pay / edit / delete write an audit-trail entry (OQ-FB-3 → A:
 *     audit-trail only, NO hard SoD block on create-vs-pay).
 *
 * Dependency note: UploadsService (invoice file quota — now only touched on a
 * genuine draft/pending replacement, never on delete); AuditService (actor-
 * correct attribution for the AP/AR money trail, AppModule.FINANCE).
 */
@Injectable()
export class BillsService {
  private readonly logger = new Logger(BillsService.name);

  constructor(
    @InjectModel(Bill.name) private billModel: Model<Bill>,
    private uploadsService: UploadsService,
    private auditService: AuditService,
  ) {}

  async findAll(workspaceId: string, query: { type?: string; status?: string }) {
    // isDeleted:false — soft-deleted bills are never returned by any read path
    // (AC-1.2). Server-side `type`/`status` filters keep the list query lean so
    // the FE no longer fetches the whole collection and filters client-side.
    const filter: any = { workspaceId, isDeleted: false };
    if (query.type) filter.type = query.type;
    if (query.status) filter.status = query.status;
    return this.billModel.find(filter).sort({ dueDate: 1 }).exec();
  }

  async create(workspaceId: string, userId: string, createDto: CreateBillDto) {
    const bill = new this.billModel({
      ...createDto,
      workspaceId,
      createdBy: userId,
      status: 'pending',
    });
    const saved = await bill.save();
    // OQ-FB-3 → A: audit-trail-only SoD. Record WHO created the payable/
    // receivable so create-vs-pay is reconstructable without a hard block.
    void this.audit(workspaceId, userId, String(saved._id), 'bill.created', {
      type: saved.type,
      amount: saved.amount,
    });
    return saved;
  }

  async findById(workspaceId: string, billId: string) {
    const bill = await this.billModel
      .findOne({ _id: billId, workspaceId, isDeleted: false })
      .exec();
    if (!bill) throw new NotFoundException('Bill not found');
    return bill;
  }

  async update(
    workspaceId: string,
    billId: string,
    updateDto: UpdateBillDto,
    userId: string,
    isOwnerOrHr: boolean,
  ) {
    // Fetch current (active-only) bill to check for invoice replacement.
    const currentBill = await this.billModel
      .findOne({ _id: billId, workspaceId, isDeleted: false })
      .exec();
    if (!currentBill) throw new NotFoundException('Bill not found');

    const replacingInvoice =
      !!updateDto.invoiceUrl &&
      !!currentBill.invoiceUrl &&
      updateDto.invoiceUrl !== currentBill.invoiceUrl;

    // D1 — block invoice replacement on a PAID bill. A settled invoice is
    // statutory evidence of the discharged obligation; swapping it could be
    // document tampering. Exception: Owner/HR may replace a mis-uploaded
    // document (e.g. wrong file attached) — that override is audited below.
    if (replacingInvoice && currentBill.status === 'paid' && !isOwnerOrHr) {
      throw new BadRequestException({
        code: 'BILL_PAID_NO_DOC_REPLACE',
        message:
          'This bill is already paid. Its invoice is settlement evidence and cannot be replaced. Ask an Owner or HR to correct a mis-uploaded document.',
      });
    }

    // Delete the OLD invoice only on a genuine replacement of a not-yet-paid
    // bill (storage-quota refund — Wave-3 Drift #36). A paid bill never reaches
    // here unless the Owner/HR override applies, in which case the prior file is
    // intentionally superseded and the swap is audited.
    if (replacingInvoice) {
      await this.uploadsService.deleteFile(currentBill.invoiceUrl, workspaceId);
    }

    const bill = await this.billModel
      .findOneAndUpdate({ _id: billId, workspaceId, isDeleted: false }, updateDto, { new: true })
      .exec();
    if (!bill) throw new NotFoundException('Bill not found');

    // OQ-FB-3 → A: audit-trail-only. Record the edit (and flag a paid-invoice
    // override explicitly so a reviewer can see who replaced a settled doc).
    void this.audit(workspaceId, userId, billId, 'bill.updated', {
      fields: Object.keys(updateDto),
      invoiceReplaced: replacingInvoice,
      paidInvoiceOverride: replacingInvoice && currentBill.status === 'paid',
    });
    return bill;
  }

  async remove(workspaceId: string, billId: string, userId: string) {
    // BUG-FB-1 FIX — SOFT-delete, not the old findOneAndDelete hard-erase.
    // A Bill is a statutory AP/AR record (Bucket B, CGST Rule 56 / IT Act
    // s.44AA, 8y). We flag it deleted in place and KEEP both the row and its
    // invoiceUrl evidence file. The physical file + row are removed ONLY by the
    // system retention purge after the 8y window (BillsRetentionPurgeCron).
    // (Removed the old `uploadsService.deleteFile(invoiceUrl)` call — deleting
    // statutory invoice evidence on a user delete was the core bug. AC-1.3.)
    const bill = await this.billModel
      .findOneAndUpdate(
        { _id: billId, workspaceId, isDeleted: false },
        {
          $set: {
            isDeleted: true,
            deletedAt: new Date(),
            deletedBy: new Types.ObjectId(userId),
          },
        },
        { new: true },
      )
      .exec();
    if (!bill) throw new NotFoundException('Bill not found');

    void this.audit(workspaceId, userId, billId, 'bill.soft_deleted', {
      type: bill.type,
      amount: bill.amount,
      status: bill.status,
    });
  }

  async recordPayment(
    workspaceId: string,
    billId: string,
    paymentDto: RecordBillPaymentDto,
    userId: string,
  ) {
    // findById already excludes soft-deleted bills (AC: cannot pay a deleted bill).
    const bill = await this.findById(workspaceId, billId);

    bill.amountPaid += paymentDto.amount;

    if (bill.amountPaid >= bill.amount) {
      bill.status = 'paid';
    } else if (bill.amountPaid > 0) {
      bill.status = 'partially_paid';
    }

    const saved = await bill.save();
    // OQ-FB-3 → A: audit-trail-only SoD. Record WHO recorded the payment so the
    // create-vs-pay separation is reconstructable (no hard block; the same
    // person MAY enter and pay a bill in this SME market, by owner decision).
    void this.audit(workspaceId, userId, billId, 'bill.payment_recorded', {
      amount: paymentDto.amount,
      paymentMode: paymentDto.paymentMode,
      newStatus: saved.status,
    });
    return saved;
  }

  /**
   * Best-effort audit write for the AP/AR money trail (OQ-FB-3 → A). Logged
   * under AppModule.FINANCE (the legacy AppModule.BILLS is deprecated — Finance/
   * Bills hardening OQ-FB-2 moves this surface onto FINANCE). A failed audit
   * must never abort the underlying money operation, so it is fire-and-forget.
   */
  private async audit(
    workspaceId: string,
    actorId: string,
    billId: string,
    action: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditService.logEvent({
        workspaceId,
        module: AppModule.FINANCE,
        entityType: 'bill',
        entityId: billId,
        action,
        actorId,
        meta,
      });
    } catch (err) {
      this.logger.warn(
        `bills audit failed ws=${workspaceId} bill=${billId} action=${action}: ${
          (err as Error)?.message ?? err
        }`,
      );
    }
  }
}
