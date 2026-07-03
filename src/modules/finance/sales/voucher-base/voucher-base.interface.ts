import { Types } from 'mongoose';

export type VoucherState = 'draft' | 'pending_approval' | 'posted' | 'cancelled' | 'void';
export type VoucherType =
  | 'quotation'
  | 'sale_order'
  | 'proforma'
  | 'delivery_challan'
  | 'sale_invoice';

export interface LineItem {
  itemId: Types.ObjectId;
  itemName: string;
  hsnSacCode?: string;
  qty: number; // in user units (billing unit, e.g. meters); 2 decimals. Source of truth for tax/amount.
  unit: string;
  // R11 textile dual-unit: optional secondary breakdown the billing qty was derived from
  // (e.g. 5 thans x 100 m = 500 m). qty stays authoritative; these are for display + print only.
  secondaryQty?: number; // e.g. number of takas/thans
  secondaryUnit?: string; // e.g. 'than', 'taka'
  conversionFactor?: number; // billing units per secondary unit (e.g. 100 m per than)
  ratePaise: number; // per-unit rate in paise
  /** Optional high-precision per-unit rate, 1/10000-rupee units (4 dp). Authoritative when present; ratePaise is its rounded 2-dp mirror. */
  rateCentiPaise?: number;
  discountPct: number; // 0–100
  discountFlatPaise?: number; // alternative to pct
  taxRate: 0 | 5 | 12 | 18 | 28;
  cessRate: number;
  isTaxInclusive: boolean; // D-18.3 vs D-18.4
  // inventory metadata (F-09):
  godownId?: Types.ObjectId;
  lotId?: Types.ObjectId;
  batchId?: Types.ObjectId;
  serialNos?: string[];
  costPaise?: number;
  // computed (filled by TaxComputationService):
  taxableValuePaise?: number;
  cgstPaise?: number;
  sgstPaise?: number;
  igstPaise?: number;
  cessPaise?: number;
  lineTotalPaise?: number;
}

export interface AdditionalCharge {
  label: string;
  amountPaise: number;
  isTaxable: boolean;
  taxRate?: 0 | 5 | 12 | 18 | 28;
}

export interface AuditEntry {
  at: Date;
  by: Types.ObjectId;
  action: string;
  before?: Record<string, any>;
  after?: Record<string, any>;
  reason?: string;
}

export interface LinkedDoc {
  voucherType: VoucherType;
  voucherId: Types.ObjectId;
  voucherNumber?: string;
}
