/**
 * VoucherGenerator — emits voucher TALLYMESSAGE blocks in date-ascending order.
 *
 * Driven primarily by `LedgerEntry` rows (the ledger projection guarantees
 * every voucher in the system has at least one entry — this is the
 * single source of truth for double-entry posting). Inventory entries
 * (BATCHALLOCATIONS, HSN, RATE) are added on demand from the source-voucher
 * collection when the voucher type carries inventory (Sales/Purchase/CN/DN/SJ).
 *
 * Ordering: vouchers are emitted in (entryDate ASC, sourceVoucherType ASC,
 * sourceVoucherNumber ASC) so the resulting XML is deterministic across runs.
 */
import { Injectable } from '@nestjs/common';
import { TallyXmlStreamWriter, LedgerEntryRow, InventoryEntryRow } from './envelope.writer';
import {
  mapVoucherType,
  voucherTypeCarriesInventory,
} from '../mappings/voucher-type-mapping';
import { paiseToTallyAmount } from '../utils/paise-to-tally-amount';
import { dateYyyymmdd } from '../utils/date-yyyymmdd';
import { deriveTallyGuid } from '../utils/deterministic-guid';
import { PreExportValidator } from '../validators/pre-export-validator.service';

/**
 * Minimal voucher-projection shape consumed by the generator. The orchestrator
 * (TallyExportService) is responsible for assembling these from raw collections;
 * the generator stays Mongoose-free for pure unit testability.
 */
export interface VoucherProjection {
  _id: string;
  sourceVoucherType: string; // internal type, e.g. 'sale_invoice'
  voucherNumber: string;
  voucherDate: Date;
  narration?: string;
  partyName?: string;
  partyGstin?: string;
  placeOfSupply?: string;
  /** Already-projected ledger lines: every line of the double-entry posting. */
  ledgerLines: Array<{
    ledgerName: string;
    /** + for debit, − for credit (Tally sign convention applied inside the generator). */
    debitPaise: number;
    creditPaise: number;
  }>;
  /**
   * Inventory lines (only for Sales/Purchase/CN/DN/SJ). Optional — empty array
   * is fine for cash-only or non-stock vouchers.
   */
  inventoryLines?: Array<{
    stockItemName: string;
    qty: number;
    unit: string;
    ratePaise: number;
    amountPaise: number;
    hsnCode?: string;
    rateOfGst?: number;
    taxability?: 'Taxable' | 'Exempt' | 'Nil Rated';
    batchNo?: string;
    godownName?: string;
    /** True for outflow (Sales / Stock issue); false for inflow (Purchase / Stock receipt). */
    isOutflow: boolean;
  }>;
}

@Injectable()
export class VoucherGenerator {
  /**
   * Emits all vouchers into the open writer in deterministic order.
   *
   * Caller must `openEnvelope()` before and `closeEnvelope()` after, and
   * have already emitted the masters section via `MastersGenerator`.
   */
  async streamVouchers(
    writer: TallyXmlStreamWriter,
    vouchers: VoucherProjection[],
  ): Promise<number> {
    const sorted = [...vouchers].sort((a, b) => {
      const da = a.voucherDate.getTime();
      const db = b.voucherDate.getTime();
      if (da !== db) return da - db;
      const ta = a.sourceVoucherType.localeCompare(b.sourceVoucherType);
      if (ta !== 0) return ta;
      return a.voucherNumber.localeCompare(b.voucherNumber);
    });

    let count = 0;
    for (const v of sorted) {
      const tallyType = mapVoucherType(v.sourceVoucherType);
      const guid = deriveTallyGuid(v._id);
      const isInvoice =
        tallyType === 'Sales' ||
        tallyType === 'Purchase' ||
        tallyType === 'Credit Note' ||
        tallyType === 'Debit Note';

      const sanitisedNum = PreExportValidator.sanitiseVoucherNumber(v.voucherNumber);

      const ledgerEntries: LedgerEntryRow[] = v.ledgerLines.map((line) => {
        // Tally sign convention: <ISDEEMEDPOSITIVE>Yes</…> for debit (asset+),
        // No for credit. Amount carries the sign in Tally: positive for debit
        // ledgers, negative for credit ledgers.
        const isDebit = line.debitPaise > 0;
        const amountPaise = isDebit ? line.debitPaise : -line.creditPaise;
        return {
          ledgerName: PreExportValidator.truncateLedgerName(line.ledgerName),
          isDeemedPositive: isDebit,
          amount: paiseToTallyAmount(amountPaise),
        };
      });

      let inventoryEntries: InventoryEntryRow[] | undefined;
      if (
        voucherTypeCarriesInventory(v.sourceVoucherType) &&
        v.inventoryLines &&
        v.inventoryLines.length > 0
      ) {
        inventoryEntries = v.inventoryLines.map((il) => {
          const sign = il.isOutflow ? -1 : 1;
          const amount = paiseToTallyAmount(sign * il.amountPaise);
          const qtyStr = `${il.qty} ${il.unit || 'NOS'}`;
          const ratePerUnit = paiseToTallyAmount(il.ratePaise);
          const row: InventoryEntryRow = {
            stockItemName: il.stockItemName,
            isDeemedPositive: !il.isOutflow,
            rate: `${ratePerUnit}/${il.unit || 'NOS'}`,
            actualQty: qtyStr,
            billedQty: qtyStr,
            amount,
            rateOfGst: il.rateOfGst,
            hsnCode: il.hsnCode,
            taxability: il.taxability ?? 'Taxable',
          };
          if (il.batchNo) {
            row.batchAllocations = [
              {
                batchName: il.batchNo,
                godownName: il.godownName || 'Main',
                amount,
                actualQty: qtyStr,
                billedQty: qtyStr,
              },
            ];
          }
          return row;
        });
      }

      await writer.writeVoucher(
        {
          guid,
          vchType: tallyType,
          date: dateYyyymmdd(v.voucherDate),
          voucherNumber: sanitisedNum,
          partyLedgerName: v.partyName
            ? PreExportValidator.truncateLedgerName(v.partyName)
            : undefined,
          partyGstin: v.partyGstin,
          placeOfSupply: v.placeOfSupply,
          narration: v.narration,
          isInvoice,
          reference: sanitisedNum || undefined,
        },
        ledgerEntries,
        inventoryEntries,
      );
      count++;
    }
    return count;
  }
}
