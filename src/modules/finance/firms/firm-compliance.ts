/**
 * Per-firm statutory derivations (Section 6.F of the finance-billing design).
 *
 * Pure functions that read a firm's annual aggregate turnover (`aato`, stored
 * in LAKHS, e.g. 500 = Rs 5 crore, 1000 = Rs 10 crore) plus its `compliance`
 * profile block and derive which statutory rules apply. These are the Phase 2
 * consumers (e-invoice mandate, 30-day IRN reporting, ITC-04 cadence, HSN digit
 * depth, default job-work classification); implemented and unit-tested now so
 * the rules are encoded in one auditable place rather than scattered as inline
 * `firm.aato > 500` checks.
 *
 * Thresholds (statutory, verified against the design spec Sections 4.2/4.3):
 *  - e-invoice mandatory: AATO > Rs 5 cr (since 1 Aug 2023).
 *  - 30-day IRN reporting: AATO >= Rs 10 cr (eff 1 Apr 2025).
 *  - ITC-04 cadence: half-yearly when AATO > Rs 5 cr, else annual (firm may
 *    override via `compliance.itc04FrequencyOverride`).
 *  - HSN digits on the invoice: 6 when AATO > Rs 5 cr, else 4.
 *
 * Input is intentionally a structural subset of `Firm` so a Mongoose document,
 * a `.lean()` plain object, or a hand-built fixture all satisfy it.
 */

/** AATO band cut for the Rs 5 cr rules (in lakhs). Strictly greater than. */
const AATO_FIVE_CRORE_LAKHS = 500;
/** AATO band cut for the Rs 10 cr rules (in lakhs). Greater than or equal. */
const AATO_TEN_CRORE_LAKHS = 1000;

export type JobWorkType = 'general_textile' | 'dyeing_printing' | 'other';

export type Itc04Frequency = 'half_yearly' | 'annual';

/** Structural subset of `Firm` that the derivations read. */
export interface FirmComplianceInput {
  /** Annual aggregate turnover in LAKHS (500 = Rs 5 cr). */
  aato?: number;
  compliance?: {
    doesDyeingPrinting?: boolean;
    defaultJobWorkType?: JobWorkType;
    compositionScheme?: boolean;
    itc04FrequencyOverride?: Itc04Frequency;
  } | null;
}

/** Normalize a possibly-undefined `aato` to a finite number of lakhs. */
function aatoLakhs(firm: FirmComplianceInput): number {
  const v = firm.aato;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * e-invoice (IRN) mandatory for this firm?
 * True when AATO > Rs 5 cr (> 500 lakhs). Mandatory since 1 Aug 2023.
 */
export function isEInvoiceMandatory(firm: FirmComplianceInput): boolean {
  return aatoLakhs(firm) > AATO_FIVE_CRORE_LAKHS;
}

/**
 * 30-day IRN reporting limit applicable to this firm?
 * True when AATO >= Rs 10 cr (>= 1000 lakhs). Effective 1 Apr 2025.
 */
export function irn30DayApplicable(firm: FirmComplianceInput): boolean {
  return aatoLakhs(firm) >= AATO_TEN_CRORE_LAKHS;
}

/**
 * ITC-04 filing cadence for this firm.
 * Firm override wins; otherwise half-yearly above Rs 5 cr, annual at or below.
 */
export function itc04Frequency(firm: FirmComplianceInput): Itc04Frequency {
  return (
    firm.compliance?.itc04FrequencyOverride ??
    (aatoLakhs(firm) > AATO_FIVE_CRORE_LAKHS ? 'half_yearly' : 'annual')
  );
}

/**
 * Mandatory HSN/SAC digit depth on the invoice for this firm.
 * 6 digits above Rs 5 cr, 4 digits at or below.
 */
export function hsnDigitsRequired(firm: FirmComplianceInput): 4 | 6 {
  return aatoLakhs(firm) > AATO_FIVE_CRORE_LAKHS ? 6 : 4;
}

/**
 * Default job-work classification for this firm.
 * Falls back to 'general_textile' when the profile is unset.
 */
export function defaultJobWorkType(firm: FirmComplianceInput): JobWorkType {
  return firm.compliance?.defaultJobWorkType ?? 'general_textile';
}

/**
 * Is this firm a composition-scheme taxpayer? A composition dealer cannot
 * collect GST on supplies and must issue a Bill of Supply (Rule 5(1)(f) /
 * Sec 10) rather than a tax invoice. True when the explicit
 * `compliance.compositionScheme` flag is set or `businessType === 'composition'`.
 */
export function isCompositionFirm(firm: FirmComplianceInput & { businessType?: string }): boolean {
  return firm.compliance?.compositionScheme === true || firm.businessType === 'composition';
}

/** A firm's GSTIN registration (primary or additional state registration). */
export interface FirmGstinEntry {
  gstin: string;
  stateCode: string;
  label?: string;
}

interface MultiGstinFirm {
  gstin?: string;
  additionalGstins?: FirmGstinEntry[] | null;
}

/**
 * All of a firm's GSTIN registrations: the primary `gstin` (state code derived
 * from its first two digits) plus any `additionalGstins`. De-duplicated by GSTIN.
 */
export function firmGstins(firm: MultiGstinFirm): FirmGstinEntry[] {
  const out: FirmGstinEntry[] = [];
  const seen = new Set<string>();
  if (firm.gstin) {
    out.push({ gstin: firm.gstin, stateCode: firm.gstin.slice(0, 2) });
    seen.add(firm.gstin);
  }
  for (const e of firm.additionalGstins ?? []) {
    if (e?.gstin && !seen.has(e.gstin)) {
      out.push({ gstin: e.gstin, stateCode: e.stateCode || e.gstin.slice(0, 2), label: e.label });
      seen.add(e.gstin);
    }
  }
  return out;
}

/**
 * Resolve the seller GSTIN to use on a document. If `requested` is one of the
 * firm's registrations it is honoured; otherwise falls back to the primary
 * `gstin`. Returns undefined only when the firm has no GSTIN at all.
 */
export function resolveSellerGstin(firm: MultiGstinFirm, requested?: string): string | undefined {
  const all = firmGstins(firm);
  if (requested && all.some((e) => e.gstin === requested)) return requested;
  return firm.gstin ?? all[0]?.gstin;
}
