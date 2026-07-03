import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

// ─── LedgerLine sub-document ─────────────────────────────────────────────────

export interface LedgerLine {
  accountId: Types.ObjectId;
  accountCode: string;
  accountName: string;
  /** Amount in paise; one of debit/credit must be > 0 */
  debit: number;
  credit: number;
  partyId?: Types.ObjectId;
}

// ─── AuditEntry sub-document ─────────────────────────────────────────────────

export interface LedgerAuditEntry {
  at: Date;
  by: Types.ObjectId;
  action: string;
  before?: Record<string, any>;
  after?: Record<string, any>;
  reason?: string;
}

// ─── LedgerEntry document ────────────────────────────────────────────────────

@Schema({ timestamps: true })
export class LedgerEntry extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: String, required: true, index: true })
  financialYear: string;

  @Prop({ type: Date, required: true })
  entryDate: Date;

  @Prop({
    type: String,
    enum: [
      'sale_invoice',
      'sale_invoice_reverse',
      'payment_in',
      'payment_out',
      'purchase_bill',
      'expense',
      'journal',
      'credit_note',
      'debit_note',
      'depreciation',
      'asset_disposal',
      'expense_reversal',
      'contra',
      'loan_emi',
      'loan_disbursement',
      'cheque_bounce',
      'cheque_pdc_mature',
      'credit_note_reversal',
      'debit_note_reversal',
      'wastage_entry',
      'manufacturing_issue',
      'manufacturing_completion',
      'manufacturing_reversal',
      'job_work_invoice',
      'job_work_invoice_reverse',
      'bank_reconciliation_new',
      'bank_reconciliation_new_reverse',
      'opening_balance',
      'salary_payment',
      'salary_advance',
      'salary_payment_reversal',
      'salary_advance_reversal',
    ],
    required: true,
  })
  entryType: string;

  @Prop({ type: Types.ObjectId, required: true })
  sourceVoucherId: Types.ObjectId;

  @Prop({ type: String, required: true })
  sourceVoucherType: string;

  @Prop({ type: String, required: true })
  sourceVoucherNumber: string;

  @Prop({ type: String, default: '' })
  narration: string;

  @Prop({
    type: [
      {
        accountId: { type: Types.ObjectId, required: true },
        accountCode: { type: String, required: true },
        accountName: { type: String, required: true },
        debit: { type: Number, required: true, default: 0 },
        credit: { type: Number, required: true, default: 0 },
        partyId: { type: Types.ObjectId },
      },
    ],
    required: true,
  })
  lines: LedgerLine[];

  @Prop({ type: Boolean, default: false })
  isReversed: boolean;

  @Prop({ type: Types.ObjectId })
  reversedBy?: Types.ObjectId;

  @Prop({ type: Date })
  reversedAt?: Date;

  @Prop({ type: Types.ObjectId, required: true })
  postedBy: Types.ObjectId;

  @Prop({ type: Date, required: true })
  postedAt: Date;

  @Prop({
    type: [
      {
        at: { type: Date },
        by: { type: Types.ObjectId },
        action: { type: String },
        before: { type: Object },
        after: { type: Object },
        reason: { type: String },
      },
    ],
    default: [],
  })
  auditLog: LedgerAuditEntry[];

  /** Set to true when this entry is cleared in a bank reconciliation session */
  @Prop({ type: Boolean, default: false })
  clearedInReconciliation: boolean;

  /** Which ReconciliationSession cleared this entry */
  @Prop({ type: Types.ObjectId })
  clearedInSessionId?: Types.ObjectId;

  /** Timestamp when the entry was cleared in reconciliation */
  @Prop({ type: Date })
  clearedAt?: Date;
}

export const LedgerEntrySchema = SchemaFactory.createForClass(LedgerEntry);

// Compound index: (workspaceId, firmId, sourceVoucherId, sourceVoucherType)
LedgerEntrySchema.index(
  { workspaceId: 1, firmId: 1, sourceVoucherId: 1, sourceVoucherType: 1 },
  { unique: true },
);
LedgerEntrySchema.index({ workspaceId: 1, firmId: 1, financialYear: 1 });
LedgerEntrySchema.index({ workspaceId: 1, firmId: 1, entryDate: -1 });
// Supports candidate-pool query in reconciliation matching engine (RESEARCH §2.1)
LedgerEntrySchema.index({ workspaceId: 1, firmId: 1, clearedInReconciliation: 1, entryDate: -1 });
// Supports party statement (R-19) and party-wise P&L (R-24) — filter by lines[].partyId
LedgerEntrySchema.index({ workspaceId: 1, firmId: 1, 'lines.partyId': 1, entryDate: -1 });
// D17: account-wise aggregation (trial balance, P&L, balance sheet, account ledger) filters +
// groups by lines[].accountCode within a firm + date window. Without this the financial-statement
// reports collection-scan the journal; this multikey index keeps them index-driven at scale.
LedgerEntrySchema.index({ workspaceId: 1, firmId: 1, 'lines.accountCode': 1, entryDate: -1 });

// ─── D17 report-cache invalidation ───────────────────────────────────────────
// Bump the firm's data version on every posting so cached report results (keyed by version) are
// transparently invalidated - the next read recomputes from the live aggregation (the source of
// truth) and re-caches. FAIL-SAFE: the cache is derived, so a bump failure must never fail a
// posting. Runs in the posting's session (atomic with the entry). Cross-link: report-cache module
// (FinanceDataVersion + ReportCacheService). Fires on every save (insert + in-place update), so
// the opening-balance edit path invalidates too.
// Guarded: attaching a hook needs a real Mongoose schema. Under the unit-test decorator-mock
// (SchemaFactory stubbed) `.post` is absent, so skip - the hook is exercised by real-Mongo
// integration tests, not the decorator-mock unit suites.
if (typeof (LedgerEntrySchema as { post?: unknown }).post === 'function') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  LedgerEntrySchema.post('save', async function (doc: any) {
    try {
      const session = doc.$session();
      await doc.db
        .model('FinanceDataVersion')
        .updateOne(
          { workspaceId: doc.workspaceId, firmId: doc.firmId },
          { $inc: { version: 1 } },
          { upsert: true, ...(session ? { session } : {}) },
        );
    } catch {
      // Best-effort: report-cache invalidation must never break a posting.
    }
  });
}
