/**
 * Net GSTR-3B Table 3.1(a) outward taxable supplies by the period's credit
 * notes.
 *
 * GSTN reports 3.1(a) NET of credit/debit notes issued within the period: a
 * sales credit note (return, discount, price/deficiency correction) reduces the
 * outward taxable value and the output tax. Each cell is clamped at 0 because
 * the portal rejects negative 3.1(a) values; any excess (credit notes exceeding
 * sales in the period) is handled via the manual-adjustment layer / next period.
 */
export interface Outward31aGross {
  txval?: number;
  igst?: number;
  cgst?: number;
  sgst?: number;
}

export interface Outward31aCreditNoteAdj {
  txval?: number;
  igst?: number;
  cgst?: number;
  sgst?: number;
}

export interface Outward31aCell {
  txval: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export function netOutward31a(
  gross: Outward31aGross,
  creditNote: Outward31aCreditNoteAdj,
): Outward31aCell {
  const net = (g?: number, c?: number) => Math.max(0, (g ?? 0) - (c ?? 0));
  return {
    txval: net(gross.txval, creditNote.txval),
    igst: net(gross.igst, creditNote.igst),
    cgst: net(gross.cgst, creditNote.cgst),
    sgst: net(gross.sgst, creditNote.sgst),
    cess: 0,
  };
}

/**
 * Net GSTR-3B Table 4A(3) standard ITC by the period's purchase debit-note ITC
 * reversals.
 *
 * When a buyer raises a debit note against a purchase (purchase return), the
 * ITC originally claimed must be reversed; the debit-note ledger entry credits
 * the input-tax accounts (1100/1101/1102). 4A(3) summed only purchase-bill ITC
 * debits, so net available ITC was overstated. Each cell is clamped at 0 (4A
 * "ITC available" cannot be negative; any excess reversal is handled via the
 * manual-adjustment layer / 4B).
 */
export interface ItcCell {
  igst?: number;
  cgst?: number;
  sgst?: number;
}

export function netItc4a(
  gross: ItcCell,
  reversal: ItcCell,
): { igst: number; cgst: number; sgst: number; cess: number } {
  const net = (g?: number, r?: number) => Math.max(0, (g ?? 0) - (r ?? 0));
  return {
    igst: net(gross.igst, reversal.igst),
    cgst: net(gross.cgst, reversal.cgst),
    sgst: net(gross.sgst, reversal.sgst),
    cess: 0,
  };
}
