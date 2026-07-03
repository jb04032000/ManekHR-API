/**
 * Phase 17 / FIN-16-03 — One-time CRM Timeline backfill (D-18).
 *
 * Materializes timeline events from existing voucher / payment / reminder
 * collections. Idempotent — bulkWrite upserts keyed on `(refModel, refId, type)`
 * (partial unique index from Plan 01). Re-running produces zero new rows.
 *
 * Pitfall 8 — chunked cursor + bulkWrite, batch 500. pLimit(8) bounds parallel
 * source-collection scans per workspace.
 *
 * Skips `invoice.paid` derivation: state transitions don't backfill cleanly
 * (we'd need to reconstruct the timeline of allocations). Fresh emits only.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import pLimit from 'p-limit';

import { SaleInvoice } from '../../../sales/sale-invoice/sale-invoice.schema';
import { PaymentReceipt } from '../../../payments/payment-receipt/payment-receipt.schema';
import { PaymentOut } from '../../../purchases/payment-out/payment-out.schema';
import { CreditNote } from '../../../credit-notes/credit-note.schema';
import { DebitNote } from '../../../debit-notes/debit-note.schema';
import { ReminderLog } from '../../../reminders/reminder-log/reminder-log.schema';
import {
  PartyTimelineEvent,
  PartyTimelineEventType,
} from '../party-timeline-event.schema';

const BATCH_SIZE = 500;
const SOURCE_PARALLELISM = 8;

export interface BackfillResult {
  workspaceId: string;
  dryRun: boolean;
  durationMs: number;
  perSource: {
    invoices: { processed: number; upserted: number };
    paymentsIn: { processed: number; upserted: number };
    paymentsOut: { processed: number; upserted: number };
    creditNotes: { processed: number; upserted: number };
    debitNotes: { processed: number; upserted: number };
    reminders: { processed: number; upserted: number };
  };
}

interface BulkOp {
  updateOne: {
    filter: { refModel: string; refId: Types.ObjectId; type: PartyTimelineEventType };
    update: { $setOnInsert: Record<string, unknown> };
    upsert: true;
  };
}

@Injectable()
export class PartyTimelineBackfillService {
  private readonly logger = new Logger(PartyTimelineBackfillService.name);

  constructor(
    @InjectModel(PartyTimelineEvent.name)
    private readonly timelineModel: Model<PartyTimelineEvent>,
    @InjectModel(SaleInvoice.name)
    private readonly saleInvoiceModel: Model<SaleInvoice>,
    @InjectModel(PaymentReceipt.name)
    private readonly paymentReceiptModel: Model<PaymentReceipt>,
    @InjectModel(PaymentOut.name)
    private readonly paymentOutModel: Model<PaymentOut>,
    @InjectModel(CreditNote.name)
    private readonly creditNoteModel: Model<CreditNote>,
    @InjectModel(DebitNote.name)
    private readonly debitNoteModel: Model<DebitNote>,
    @InjectModel(ReminderLog.name)
    private readonly reminderLogModel: Model<ReminderLog>,
  ) {}

  async run(opts: { wsId: string; dryRun?: boolean }): Promise<BackfillResult> {
    const t0 = Date.now();
    const dryRun = opts.dryRun === true;
    const wsObjId = new Types.ObjectId(opts.wsId);
    const limit = pLimit(SOURCE_PARALLELISM);

    const tasks = await Promise.all([
      limit(() =>
        this.backfillCollection({
          model: this.saleInvoiceModel,
          refModel: 'SaleInvoice',
          eventType: 'invoice.created',
          baseFilter: {
            workspaceId: wsObjId,
            isDeleted: { $ne: true },
            state: 'posted',
          },
          dryRun,
          buildPayload: (doc) => ({
            workspaceId: wsObjId,
            firmId: (doc as any).firmId,
            partyId: (doc as any).partyId,
            occurredAt: (doc as any).voucherDate ?? (doc as any).createdAt,
            actorUserId: (doc as any).postedBy ?? (doc as any).createdBy,
            summary: `Invoice ${(doc as any).voucherNumber ?? ''} for paise=${(doc as any).grandTotalPaise} created`,
            meta: {
              voucherNumber: (doc as any).voucherNumber,
              amountPaise: (doc as any).grandTotalPaise,
            },
          }),
        }),
      ),
      limit(() =>
        this.backfillCollection({
          model: this.paymentReceiptModel,
          refModel: 'PaymentReceipt',
          eventType: 'payment.received',
          baseFilter: {
            workspaceId: wsObjId,
            isDeleted: { $ne: true },
            state: 'posted',
          },
          dryRun,
          buildPayload: (doc) => ({
            workspaceId: wsObjId,
            firmId: (doc as any).firmId,
            partyId: (doc as any).partyId,
            occurredAt: (doc as any).receiptDate ?? (doc as any).createdAt,
            actorUserId: (doc as any).postedBy,
            summary: `Payment received via ${(doc as any).paymentMode}`,
            meta: {
              amountPaise: (doc as any).totalAmountPaise,
              mode: (doc as any).paymentMode,
            },
          }),
        }),
      ),
      limit(() =>
        this.backfillCollection({
          model: this.paymentOutModel,
          refModel: 'PaymentOut',
          eventType: 'payment.sent',
          baseFilter: {
            workspaceId: wsObjId,
            isDeleted: { $ne: true },
            state: 'posted',
          },
          dryRun,
          buildPayload: (doc) => ({
            workspaceId: wsObjId,
            firmId: (doc as any).firmId,
            partyId: (doc as any).partyId,
            occurredAt: (doc as any).paymentDate ?? (doc as any).createdAt,
            actorUserId: (doc as any).postedBy,
            summary: `Payment sent via ${(doc as any).paymentMode}`,
            meta: {
              amountPaise: (doc as any).totalAmountPaise,
              mode: (doc as any).paymentMode,
            },
          }),
        }),
      ),
      limit(() =>
        this.backfillCollection({
          model: this.creditNoteModel,
          refModel: 'CreditNote',
          eventType: 'credit_note.created',
          baseFilter: { workspaceId: wsObjId, state: 'posted' },
          dryRun,
          buildPayload: (doc) => ({
            workspaceId: wsObjId,
            firmId: (doc as any).firmId,
            partyId: (doc as any).partyId,
            occurredAt: (doc as any).voucherDate ?? (doc as any).createdAt,
            actorUserId: (doc as any).postedBy,
            summary: `Credit Note ${(doc as any).voucherNumber ?? ''}`,
            meta: {
              voucherNumber: (doc as any).voucherNumber,
              amountPaise: (doc as any).grandTotalPaise,
            },
          }),
        }),
      ),
      limit(() =>
        this.backfillCollection({
          model: this.debitNoteModel,
          refModel: 'DebitNote',
          eventType: 'debit_note.created',
          baseFilter: { workspaceId: wsObjId, state: 'posted' },
          dryRun,
          buildPayload: (doc) => ({
            workspaceId: wsObjId,
            firmId: (doc as any).firmId,
            partyId: (doc as any).partyId,
            occurredAt: (doc as any).voucherDate ?? (doc as any).createdAt,
            actorUserId: (doc as any).postedBy,
            summary: `Debit Note ${(doc as any).voucherNumber ?? ''}`,
            meta: {
              voucherNumber: (doc as any).voucherNumber,
              amountPaise: (doc as any).grandTotalPaise,
            },
          }),
        }),
      ),
      limit(() =>
        this.backfillCollection({
          model: this.reminderLogModel,
          refModel: 'ReminderLog',
          eventType: 'reminder.sent',
          baseFilter: { workspaceId: wsObjId, status: 'sent' },
          dryRun,
          buildPayload: (doc) => ({
            workspaceId: wsObjId,
            firmId: (doc as any).firmId,
            partyId: (doc as any).partyId,
            occurredAt: (doc as any).createdAt ?? new Date(),
            summary: `${(doc as any).channel ?? 'reminder'} reminder sent`,
            meta: {
              channel: (doc as any).channel,
              recipient: (doc as any).recipient,
              templateKind: (doc as any).templateKind,
            },
          }),
        }),
      ),
    ]);

    const [invoices, paymentsIn, paymentsOut, creditNotes, debitNotes, reminders] = tasks;

    const result: BackfillResult = {
      workspaceId: opts.wsId,
      dryRun,
      durationMs: Date.now() - t0,
      perSource: { invoices, paymentsIn, paymentsOut, creditNotes, debitNotes, reminders },
    };
    this.logger.log(
      `party-timeline backfill complete wsId=${opts.wsId} dryRun=${dryRun} ` +
        `result=${JSON.stringify(result.perSource)} durationMs=${result.durationMs}`,
    );
    return result;
  }

  // ─── core: cursor → batch → bulkWrite upsert ──────────────────────────────

  private async backfillCollection<T>(args: {
    model: Model<T>;
    refModel: string;
    eventType: PartyTimelineEventType;
    baseFilter: Record<string, unknown>;
    dryRun: boolean;
    buildPayload: (doc: T) => Record<string, unknown>;
  }): Promise<{ processed: number; upserted: number }> {
    const cursor = args.model.find(args.baseFilter as any).cursor();
    let processed = 0;
    let upserted = 0;
    let buffer: BulkOp[] = [];

    for await (const doc of cursor) {
      processed++;
      const refId = (doc as any)._id as Types.ObjectId;
      const partyId = (doc as any).partyId;
      // Skip docs without partyId — can't materialize a party timeline event.
      if (!partyId) continue;

      const payload = args.buildPayload(doc);
      buffer.push({
        updateOne: {
          filter: { refModel: args.refModel, refId, type: args.eventType },
          update: {
            $setOnInsert: {
              ...payload,
              type: args.eventType,
              refModel: args.refModel,
              refId,
            },
          },
          upsert: true,
        },
      });

      if (buffer.length >= BATCH_SIZE) {
        upserted += await this.flush(buffer, args.dryRun);
        buffer = [];
      }
    }
    if (buffer.length > 0) {
      upserted += await this.flush(buffer, args.dryRun);
    }
    return { processed, upserted };
  }

  private async flush(ops: BulkOp[], dryRun: boolean): Promise<number> {
    if (dryRun) return 0;
    const res = await this.timelineModel.bulkWrite(ops as any, {
      ordered: false,
    });
    // res.upsertedCount is the number of newly-inserted rows; existing rows
    // (already-backfilled) match the filter and produce no insert (idempotency).
    return (res as any).upsertedCount ?? 0;
  }
}
