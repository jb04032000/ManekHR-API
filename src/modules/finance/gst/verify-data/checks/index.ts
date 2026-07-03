import { Model, Types } from 'mongoose';
import type { SaleInvoice } from '../../../../sales/sale-invoice/sale-invoice.schema';
import type { CreditNote } from '../../../../credit-notes/credit-note.schema';
import type { DebitNote } from '../../../../debit-notes/debit-note.schema';
import type { GodownBalance } from '../../../../inventory/godown-balances/godown-balance.schema';
import type { LedgerEntry } from '../../../../sales/ledger-posting/ledger-entry.schema';
import type { Firm } from '../../../../firms/firm.schema';
import type { Party } from '../../../../parties/party.schema';
import type { GstRateHistoryService } from '../../gst-rate-history/gst-rate-history.service';

// ─── Wave 4 Check Dependency Bundle ──────────────────────────────────────────

/**
 * CheckDeps — full dependency bundle for all 11 Verify-My-Data check functions.
 *
 * Superset of CommonCheckDeps (Plan 12-04 gstr1/checks/common.ts). The thin
 * re-exporters (C-01/02/03/05/08) pluck the CommonCheckDeps subset and delegate.
 * Fresh logic checks (C-04/06/07/09/10/11) use the additional fields.
 */
export interface CheckDeps {
  saleInvoiceModel: Model<SaleInvoice>;
  creditNoteModel: Model<CreditNote>;
  debitNoteModel: Model<DebitNote>;
  godownBalanceModel: Model<GodownBalance>;
  ledgerEntryModel: Model<LedgerEntry>;
  firmModel: Model<Firm>;
  partyModel: Model<Party>;
  /** Required for C-11 rate discrepancy check */
  gstRateHistoryService: GstRateHistoryService;
  wsId: Types.ObjectId;
  firmId: Types.ObjectId;
  /** Period in 'MMYYYY' format, e.g. '042025' = April 2025 */
  period: string;
  startDate: Date;
  endDate: Date;
  /** Injection point for testability (use new Date() in production) */
  now: Date;
}

// ─── Barrel exports for all 11 check functions ───────────────────────────────

export { checkC01 } from './c-01-missing-gstin-b2b';
export { checkC02 } from './c-02-pos-mismatch';
export { checkC03 } from './c-03-missing-hsn';
export { checkC04 } from './c-04-party-balance-mismatch';
export { checkC05 } from './c-05-cn-dn-without-source';
export { checkC06 } from './c-06-negative-stock';
export { checkC07 } from './c-07-late-fee-gap';
export { checkC08 } from './c-08-cgst-sgst-rounding';
export { checkC09 } from './c-09-irn-backlog';
export { checkC10 } from './c-10-ewb-expiry';
export { checkC11 } from './c-11-rate-discrepancy';
