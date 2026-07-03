/**
 * Reverse-charge (RCM) purchase accounting rules (Sec 9(3)/9(4) CGST Act).
 *
 * Under reverse charge the RECIPIENT (this firm), not the supplier, is liable to
 * pay the GST to the government. So an RCM purchase bill must:
 *   1. self-assess the output tax as a LIABILITY -> Cr Output GST Payable
 *      (this is what feeds GSTR-3B table 3.1(d)); and
 *   2. claim the matching ITC -> Dr Input GST (GSTR-3B table 4A(5)); and
 *   3. owe the supplier only the TAXABLE value - the tax is paid to the
 *      government, not to the supplier.
 *
 * Pure functions so the money rules are unit-tested without standing up the
 * posting transaction + Mongoose.
 */

/** Standard GST output-payable account codes in this chart of accounts. */
export const RCM_OUTPUT_CODE = { igst: '2006', cgst: '2007', sgst: '2008' } as const;

export interface RcmOutputTaxLine {
  accountCode: string;
  paise: number;
}

interface RcmBillTax {
  isReverseCharge?: boolean;
  cgstPaise?: number;
  sgstPaise?: number;
  igstPaise?: number;
}

/**
 * The output-tax liability lines to credit for a reverse-charge bill.
 * Intra-state -> CGST (2007) + SGST (2008); inter-state -> IGST (2006).
 * Returns [] for non-RCM bills or zero-tax components.
 */
export function rcmOutputTaxLines(bill: RcmBillTax, isIntraState: boolean): RcmOutputTaxLine[] {
  if (!bill.isReverseCharge) return [];
  const out: RcmOutputTaxLine[] = [];
  if (isIntraState) {
    if ((bill.cgstPaise ?? 0) > 0)
      out.push({ accountCode: RCM_OUTPUT_CODE.cgst, paise: bill.cgstPaise });
    if ((bill.sgstPaise ?? 0) > 0)
      out.push({ accountCode: RCM_OUTPUT_CODE.sgst, paise: bill.sgstPaise });
  } else if ((bill.igstPaise ?? 0) > 0) {
    out.push({ accountCode: RCM_OUTPUT_CODE.igst, paise: bill.igstPaise });
  }
  return out;
}

/**
 * Amount the supplier (creditor) is owed BEFORE TDS: under reverse charge only
 * the taxable value (the tax is self-paid to the government); otherwise the full
 * grand total (taxable + tax, which the supplier collected).
 */
export function supplierCreditorBasePaise(bill: {
  isReverseCharge?: boolean;
  taxableValuePaise?: number;
  grandTotalPaise?: number;
}): number {
  return bill.isReverseCharge ? (bill.taxableValuePaise ?? 0) : (bill.grandTotalPaise ?? 0);
}
