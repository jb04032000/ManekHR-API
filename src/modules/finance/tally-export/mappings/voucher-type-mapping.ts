/**
 * Internal voucher class → Tally VoucherTypeName mapping (D-05).
 *
 * Tally ERP 9 + TallyPrime ship these voucher-type names pre-seeded; the
 * exporter does NOT need to emit `<VOUCHERTYPE>` master records — referencing
 * by name is sufficient.
 */

const MAP: Record<string, string> = {
  // Sales family
  sale_invoice: 'Sales',
  tax_invoice: 'Sales',
  bill_of_supply: 'Sales',
  export_invoice: 'Sales',
  sales: 'Sales',

  // Sales returns / Credit notes
  sales_return: 'Credit Note',
  credit_note: 'Credit Note',

  // Purchase family
  purchase_bill: 'Purchase',
  purchase: 'Purchase',

  // Purchase returns / Debit notes
  purchase_return: 'Debit Note',
  debit_note: 'Debit Note',

  // Receipts (party pays us)
  payment_in: 'Receipt',
  receipt: 'Receipt',

  // Payments out (we pay party)
  payment_out: 'Payment',
  payment: 'Payment',

  // Journal
  journal_voucher: 'Journal',
  journal: 'Journal',

  // Contra
  contra: 'Contra',

  // Stock journal family
  manufacturing_voucher: 'Stock Journal',
  manufacturing_issue: 'Stock Journal',
  manufacturing_completion: 'Stock Journal',
  job_work_out: 'Stock Journal',
  job_work_in: 'Stock Journal',
  jw_lot: 'Stock Journal',
  grn_return: 'Stock Journal',
};

export function mapVoucherType(internalType: string): string {
  if (!internalType) return 'Journal';
  const m = MAP[internalType];
  if (m) return m;
  // Default unknown voucher to Journal — round-trips as a generic posting.
  return 'Journal';
}

/**
 * Returns true if the voucher type carries inventory (Sales/Purchase/CN/DN/SJ).
 */
export function voucherTypeCarriesInventory(internalType: string): boolean {
  const tallyType = mapVoucherType(internalType);
  return (
    tallyType === 'Sales' ||
    tallyType === 'Purchase' ||
    tallyType === 'Credit Note' ||
    tallyType === 'Debit Note' ||
    tallyType === 'Stock Journal'
  );
}
