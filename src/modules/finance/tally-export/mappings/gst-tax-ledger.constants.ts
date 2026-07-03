/**
 * Standard GST tax-ledger seeds for Tally export (D-07).
 *
 * On first import, these four ledgers are auto-created in Tally with
 * `<TAXTYPE>GST</TAXTYPE>` + `<DUTYHEAD>` set per row. Subsequent imports
 * reference them by name (idempotent).
 *
 * All four belong under the Tally primary group "Duties & Taxes".
 */

export interface TallyTaxLedger {
  /** Ledger name as written to `<LEDGER NAME="…">`. */
  name: string;
  /** Tally `<DUTYHEAD>` enum value (CGST/SGST/IGST/CESS). */
  dutyHead: 'CGST' | 'SGST' | 'IGST' | 'CESS';
  /** Tally `<TAXTYPE>` — always 'GST' in this constant. */
  taxType: 'GST';
  /** Tally primary group parent. */
  parentGroup: 'Duties & Taxes';
}

export const TAX_LEDGERS: TallyTaxLedger[] = [
  { name: 'CGST', dutyHead: 'CGST', taxType: 'GST', parentGroup: 'Duties & Taxes' },
  { name: 'SGST', dutyHead: 'SGST', taxType: 'GST', parentGroup: 'Duties & Taxes' },
  { name: 'IGST', dutyHead: 'IGST', taxType: 'GST', parentGroup: 'Duties & Taxes' },
  { name: 'CESS', dutyHead: 'CESS', taxType: 'GST', parentGroup: 'Duties & Taxes' },
];
