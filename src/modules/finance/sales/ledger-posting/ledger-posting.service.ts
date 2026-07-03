import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, ClientSession } from 'mongoose';
import { LedgerEntry, LedgerLine } from './ledger-entry.schema';
import { Account } from '../../ledger/account.schema';
import { AccountsService } from '../../ledger/accounts.service';
import { TaxComputationResult } from '../tax-computation/tax-computation.service';
import { PurchaseBill } from '../../purchases/purchase-bill/purchase-bill.schema';
import { rcmOutputTaxLines } from '../../purchases/purchase-bill/purchase-bill-rcm.rules';
import { PaymentOut } from '../../purchases/payment-out/payment-out.schema';
import { CapitalGoodsItcSchedule } from '../../purchases/capital-goods-itc/capital-goods-itc-schedule.schema';
import { ExpenseVoucher } from '../../expenses/expense-voucher.schema';
import { JournalVoucher } from '../../journal-vouchers/journal-voucher.schema';
import { CreditNote } from '../../credit-notes/credit-note.schema';
import { DebitNote } from '../../debit-notes/debit-note.schema';
import { WastageEntryDocument } from '../../inventory/wastage/wastage-entry.schema';
import { ManufacturingVoucherDocument } from '../../manufacturing/manufacturing-vouchers/manufacturing-voucher.schema';

// ─── CoA code constants ──────────────────────────────────────────────────────

const CODE_CASH = '1001';
const CODE_STOCK = '1004';
const CODE_WASTAGE_EXPENSE = '5018';
const CODE_BANK = '1002';

// TDS Payable accounts (expense / payment-out context)
const CODE_TDS_PAY_194C = '2011';
const CODE_TDS_PAY_194H = '2012';
const CODE_TDS_PAY_194J = '2013';
// Additional codes used by Wave 3+ (contra / cheque / loan)
const CODE_INTEREST_ON_LOAN = '5015';
// ITC Input Credit accounts
const CODE_IGST_INPUT = '1100';
const CODE_CGST_INPUT = '1101';
const CODE_SGST_INPUT = '1102';
const CODE_DEBTORS = '1003';
const CODE_ADVANCE_FROM_CUSTOMERS = '2002';
const CODE_SALES = '4001';
const CODE_SALES_RETURNS = '4009'; // #14: contra-revenue account credit notes debit (sales returns)
const CODE_CGST_PAY = '2007';
const CODE_SGST_PAY = '2008';
const CODE_IGST_PAY = '2006';
const CODE_TCS_PAY = '2004';
const CODE_ROUND_OFF_GAIN = '4005';
const CODE_ROUND_OFF_LOSS = '5010';

// ─── PaymentIn posting options ───────────────────────────────────────────────

export interface PostPaymentInOptions {
  session?: ClientSession;
  userId: string;
  firm: {
    _id: Types.ObjectId;
    workspaceId: Types.ObjectId;
    gstin?: string;
  };
}

// ─── Invoice shape (minimal — full schema in Wave 3) ────────────────────────

export interface PostSaleInvoiceOptions {
  session?: ClientSession;
  userId: string;
  firm: {
    _id: Types.ObjectId;
    workspaceId: Types.ObjectId;
    gstin?: string;
  };
  party: {
    _id: Types.ObjectId;
    name: string;
  };
  invoice: {
    _id: Types.ObjectId;
    voucherNumber: string;
    voucherType: string;
    invoiceDate: Date;
    financialYear: string;
  };
  isIntraState: boolean;
}

// ─── Expense Voucher posting options ─────────────────────────────────────────

export interface PostExpenseVoucherOptions {
  session?: ClientSession;
  userId: string;
  firm: {
    _id: Types.ObjectId;
    workspaceId: Types.ObjectId;
    gstin?: string;
  };
}

export interface PostContraEntryOptions extends PostExpenseVoucherOptions {
  voucherId: Types.ObjectId;
  voucherNumber: string;
  voucherDate: Date;
  financialYear: string;
}

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class LedgerPostingService {
  constructor(
    @InjectModel(LedgerEntry.name)
    private readonly model: Model<LedgerEntry>,
    @InjectModel(Account.name)
    private readonly accountModel: Model<Account>,
    private readonly accountsService: AccountsService,
  ) {}

  /**
   * Creates a balanced double-entry LedgerEntry for a posted Tax Invoice.
   *
   * Journal (intra-state):
   *   Dr  1003 Sundry Debtors       grandTotal
   *     Cr  4001 Sales              taxableValue
   *     Cr  2007 CGST Payable       cgstPaise
   *     Cr  2008 SGST Payable       sgstPaise
   *     Cr  (cess payable)          cessPaise     [if > 0 — account seeded separately]
   *     Cr  2004 TCS Payable        tcsPaise      [if > 0]
   *     Cr/Dr round-off             roundOffPaise [if != 0]
   *
   * Journal (inter-state):
   *   Dr  1003 Sundry Debtors       grandTotal
   *     Cr  4001 Sales              taxableValue
   *     Cr  2006 IGST Payable       igstPaise
   *     ...
   *
   * Invariant: sum(debit) === sum(credit) — throws InternalServerErrorException if violated.
   */
  async postSaleInvoice(
    taxResult: TaxComputationResult,
    opts: PostSaleInvoiceOptions,
  ): Promise<LedgerEntry> {
    const { invoice, firm, party, userId, session, isIntraState } = opts;
    const workspaceId = firm.workspaceId.toString();
    const firmId = firm._id.toString();

    // Resolve account IDs via CoA codes
    const [debtorsAcc, salesAcc] = await Promise.all([
      this.accountsService.findByCode(workspaceId, firmId, CODE_DEBTORS),
      this.accountsService.findByCode(workspaceId, firmId, CODE_SALES),
    ]);

    const lines: LedgerLine[] = [];

    // Dr Party (Debtors) — full grand total
    lines.push({
      accountId: debtorsAcc._id,
      accountCode: CODE_DEBTORS,
      accountName: debtorsAcc.name,
      debit: taxResult.grandTotalPaise,
      credit: 0,
      partyId: party._id,
    });

    // Cr Sales A/c — taxable value
    lines.push({
      accountId: salesAcc._id,
      accountCode: CODE_SALES,
      accountName: salesAcc.name,
      debit: 0,
      credit: taxResult.taxableValuePaise,
    });

    if (isIntraState) {
      // Cr CGST Payable
      if (taxResult.cgstPaise > 0) {
        const acc = await this.accountsService.findByCode(workspaceId, firmId, CODE_CGST_PAY);
        lines.push({
          accountId: acc._id,
          accountCode: CODE_CGST_PAY,
          accountName: acc.name,
          debit: 0,
          credit: taxResult.cgstPaise,
        });
      }
      // Cr SGST Payable
      if (taxResult.sgstPaise > 0) {
        const acc = await this.accountsService.findByCode(workspaceId, firmId, CODE_SGST_PAY);
        lines.push({
          accountId: acc._id,
          accountCode: CODE_SGST_PAY,
          accountName: acc.name,
          debit: 0,
          credit: taxResult.sgstPaise,
        });
      }
    } else {
      // Cr IGST Payable
      if (taxResult.igstPaise > 0) {
        const acc = await this.accountsService.findByCode(workspaceId, firmId, CODE_IGST_PAY);
        lines.push({
          accountId: acc._id,
          accountCode: CODE_IGST_PAY,
          accountName: acc.name,
          debit: 0,
          credit: taxResult.igstPaise,
        });
      }
    }

    // Cr TCS Payable (if applicable)
    if (taxResult.tcsPaise > 0) {
      const acc = await this.accountsService.findByCode(workspaceId, firmId, CODE_TCS_PAY);
      lines.push({
        accountId: acc._id,
        accountCode: CODE_TCS_PAY,
        accountName: acc.name,
        debit: 0,
        credit: taxResult.tcsPaise,
      });
    }

    // Round-off (D-18.6)
    if (taxResult.roundOffPaise !== 0) {
      if (taxResult.roundOffPaise > 0) {
        // grandTotal > rawTotal → gain → Cr 4005
        const acc = await this.accountsService.findByCode(workspaceId, firmId, CODE_ROUND_OFF_GAIN);
        lines.push({
          accountId: acc._id,
          accountCode: CODE_ROUND_OFF_GAIN,
          accountName: acc.name,
          debit: 0,
          credit: taxResult.roundOffPaise,
        });
      } else {
        // grandTotal < rawTotal → loss → Dr 5010
        const acc = await this.accountsService.findByCode(workspaceId, firmId, CODE_ROUND_OFF_LOSS);
        lines.push({
          accountId: acc._id,
          accountCode: CODE_ROUND_OFF_LOSS,
          accountName: acc.name,
          debit: Math.abs(taxResult.roundOffPaise),
          credit: 0,
        });
      }
    }

    // ── Invariant check: sum(debit) === sum(credit) ──────────────────────────
    this.enforceInvariant(lines);

    const entry = new this.model({
      workspaceId: firm.workspaceId,
      firmId: firm._id,
      financialYear: invoice.financialYear,
      entryDate: invoice.invoiceDate,
      entryType: 'sale_invoice',
      sourceVoucherId: invoice._id,
      sourceVoucherType: invoice.voucherType,
      sourceVoucherNumber: invoice.voucherNumber,
      narration: `Tax Invoice ${invoice.voucherNumber} to ${party.name}`,
      lines,
      isReversed: false,
      postedBy: new Types.ObjectId(userId),
      postedAt: new Date(),
      auditLog: [],
    });

    return entry.save({ session });
  }

  /**
   * Creates a balanced double-entry LedgerEntry for a posted PaymentReceipt.
   *
   * Journal:
   *   Dr  1001 Cash / 1002 Bank         totalAmountPaise
   *     Cr  1003 Sundry Debtors          sum(allocatedPaise)   [if > 0, with partyId]
   *     Cr  2002 Advance from Customers  unappliedPaise         [if > 0]
   *
   * Invariant: sum(debit) === sum(credit) — throws InternalServerErrorException if violated.
   */
  async postPaymentIn(
    receipt: {
      _id: Types.ObjectId;
      workspaceId: Types.ObjectId;
      firmId: Types.ObjectId;
      financialYear: string;
      receiptDate: Date;
      partyId: Types.ObjectId;
      partySnapshot: Record<string, any>;
      paymentMode: string;
      totalAmountPaise: number;
      allocations: Array<{ allocatedPaise: number }>;
      unappliedPaise: number;
      voucherNumber?: string;
    },
    opts: PostPaymentInOptions,
  ): Promise<void> {
    const { firm, userId, session } = opts;
    const workspaceId = firm.workspaceId.toString();
    const firmId = firm._id.toString();

    const cashBankCode = receipt.paymentMode === 'cash' ? CODE_CASH : CODE_BANK;
    const cashBankAcc = await this.accountsService.findByCode(workspaceId, firmId, cashBankCode);

    const lines: LedgerLine[] = [];

    // Dr Cash / Bank — full receipt amount
    lines.push({
      accountId: cashBankAcc._id,
      accountCode: cashBankCode,
      accountName: cashBankAcc.name,
      debit: receipt.totalAmountPaise,
      credit: 0,
    });

    const appliedPaise = receipt.allocations.reduce((s, a) => s + a.allocatedPaise, 0);

    // Cr Sundry Debtors — sum of allocations (with partyId for party ledger)
    if (appliedPaise > 0) {
      const debtorsAcc = await this.accountsService.findByCode(workspaceId, firmId, CODE_DEBTORS);
      lines.push({
        accountId: debtorsAcc._id,
        accountCode: CODE_DEBTORS,
        accountName: debtorsAcc.name,
        debit: 0,
        credit: appliedPaise,
        partyId: receipt.partyId,
      });
    }

    // Cr Advance from Customers — unapplied amount
    if (receipt.unappliedPaise > 0) {
      const advanceAcc = await this.accountsService.findByCode(
        workspaceId,
        firmId,
        CODE_ADVANCE_FROM_CUSTOMERS,
      );
      lines.push({
        accountId: advanceAcc._id,
        accountCode: CODE_ADVANCE_FROM_CUSTOMERS,
        accountName: advanceAcc.name,
        debit: 0,
        credit: receipt.unappliedPaise,
      });
    }

    // ── Invariant check ──────────────────────────────────────────────────────
    this.enforceInvariant(lines);

    const partyName = (receipt.partySnapshot as any)?.name ?? 'party';
    const entry = new this.model({
      workspaceId: receipt.workspaceId,
      firmId: receipt.firmId,
      financialYear: receipt.financialYear,
      entryDate: receipt.receiptDate,
      entryType: 'payment_in',
      sourceVoucherId: receipt._id,
      sourceVoucherType: 'payment_receipt',
      sourceVoucherNumber: receipt.voucherNumber,
      narration: `Payment received from ${partyName}`,
      lines,
      isReversed: false,
      postedBy: new Types.ObjectId(userId),
      postedAt: new Date(),
      auditLog: [],
    });

    await entry.save({ session });
  }

  // ─── Private helper: enforce debit === credit invariant ─────────────────────

  private enforceInvariant(lines: LedgerLine[]): void {
    const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
    const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
    if (totalDebit !== totalCredit) {
      const err = new InternalServerErrorException(
        `Ledger imbalance detected: debit=${totalDebit} credit=${totalCredit}`,
      );
      // D23: a money imbalance must never pass silently. Alert ops with the line
      // breakdown (account codes + paise only - no party/PII) before failing the post.
      Sentry.captureException(err, {
        tags: { module: 'finance', op: 'ledger_posting_imbalance' },
        extra: {
          totalDebit,
          totalCredit,
          delta: totalDebit - totalCredit,
          lines: lines.map((l) => ({ code: l.accountCode, debit: l.debit, credit: l.credit })),
        },
      });
      throw err;
    }
  }

  // ─── postPurchaseBill ─────────────────────────────────────────────────────

  /**
   * Creates a balanced double-entry LedgerEntry for a posted PurchaseBill.
   *
   * Journal (intra-state):
   *   Dr  5001 Purchases                 taxableValuePaise
   *   Dr  1101 CGST Input Credit         sum(non-capital cgstPaise)   [if > 0]
   *   Dr  1102 SGST Input Credit         sum(non-capital sgstPaise)   [if > 0]
   *   Dr  1103 Capital Goods ITC Deferred sum(capital lineItem ITC)   [if > 0]
   *     Cr  2001 Sundry Creditors         netPayableToCreditorsAfterTdsPaise
   *     Cr  2014 TDS Payable 194Q         tds194Q.tdsPaise             [if applicable]
   *
   * Journal (inter-state):
   *   Dr  5001 Purchases                 taxableValuePaise
   *   Dr  1100 IGST Input Credit         sum(non-capital igstPaise)   [if > 0]
   *   Dr  1103 Capital Goods ITC Deferred sum(capital lineItem ITC)   [if > 0]
   *     Cr  2001 Sundry Creditors         netPayableToCreditorsAfterTdsPaise
   *     Cr  2014 TDS Payable 194Q         tds194Q.tdsPaise             [if applicable]
   *
   * Invariant enforced before save.
   */
  async postPurchaseBill(
    bill: PurchaseBill,
    opts: {
      session?: ClientSession;
      userId: string;
      firm: { _id: Types.ObjectId; workspaceId: Types.ObjectId };
      isIntraState: boolean;
    },
  ): Promise<void> {
    const { session, userId, firm, isIntraState } = opts;
    const wsId = firm.workspaceId.toString();
    const firmId = firm._id.toString();
    const lines: LedgerLine[] = [];

    // Dr 5001 Purchases — full taxable value
    const purchasesAcc = await this.accountsService.findByCode(wsId, firmId, '5001');
    lines.push({
      accountId: purchasesAcc._id,
      accountCode: '5001',
      accountName: purchasesAcc.name,
      debit: bill.taxableValuePaise,
      credit: 0,
    });

    // Aggregate ITC per line: capital-goods → 1103, regular → 1100/1101/1102
    let totalCgstNonCap = 0;
    let totalSgstNonCap = 0;
    let totalIgstNonCap = 0;
    let totalCapitalGoodsItc = 0;

    for (const line of bill.lineItems) {
      if (line.isCapitalGoods) {
        totalCapitalGoodsItc +=
          (line.cgstPaise ?? 0) + (line.sgstPaise ?? 0) + (line.igstPaise ?? 0);
      } else {
        totalCgstNonCap += line.cgstPaise ?? 0;
        totalSgstNonCap += line.sgstPaise ?? 0;
        totalIgstNonCap += line.igstPaise ?? 0;
      }
    }

    if (isIntraState) {
      if (totalCgstNonCap > 0) {
        const cgstAcc = await this.accountsService.findByCode(wsId, firmId, '1101');
        lines.push({
          accountId: cgstAcc._id,
          accountCode: '1101',
          accountName: cgstAcc.name,
          debit: totalCgstNonCap,
          credit: 0,
        });
      }
      if (totalSgstNonCap > 0) {
        const sgstAcc = await this.accountsService.findByCode(wsId, firmId, '1102');
        lines.push({
          accountId: sgstAcc._id,
          accountCode: '1102',
          accountName: sgstAcc.name,
          debit: totalSgstNonCap,
          credit: 0,
        });
      }
    } else {
      if (totalIgstNonCap > 0) {
        const igstAcc = await this.accountsService.findByCode(wsId, firmId, '1100');
        lines.push({
          accountId: igstAcc._id,
          accountCode: '1100',
          accountName: igstAcc.name,
          debit: totalIgstNonCap,
          credit: 0,
        });
      }
    }

    // Dr 1103 Capital Goods ITC Deferred (routes to deferred amortisation schedule)
    if (totalCapitalGoodsItc > 0) {
      const capAcc = await this.accountsService.findByCode(wsId, firmId, '1103');
      lines.push({
        accountId: capAcc._id,
        accountCode: '1103',
        accountName: capAcc.name,
        debit: totalCapitalGoodsItc,
        credit: 0,
      });
    }

    // Cr 2006/2007/2008 Output GST Payable — reverse-charge self-assessed liability.
    // Under RCM the recipient owes the tax to the government (Sec 9(3)/9(4)); this is
    // the liability that feeds GSTR-3B 3.1(d), and is claimed back as ITC above
    // (4A(5)). The supplier is credited only the taxable value (purchase-bill.service).
    for (const rcmLine of rcmOutputTaxLines(bill, isIntraState)) {
      const rcmAcc = await this.accountsService.findByCode(wsId, firmId, rcmLine.accountCode);
      lines.push({
        accountId: rcmAcc._id,
        accountCode: rcmLine.accountCode,
        accountName: rcmAcc.name,
        debit: 0,
        credit: rcmLine.paise,
      });
    }

    // Cr 2001 Sundry Creditors — net of TDS-194Q (already deducted at post time)
    const creditorsAcc = await this.accountsService.findByCode(wsId, firmId, '2001');
    lines.push({
      accountId: creditorsAcc._id,
      accountCode: '2001',
      accountName: creditorsAcc.name,
      debit: 0,
      credit: bill.netPayableToCreditorsAfterTdsPaise,
      partyId: bill.partyId,
    });

    // Cr 2014 TDS Payable 194Q (if 194Q was deducted)
    if (bill.tds194Q && bill.tds194Q.tdsPaise > 0) {
      const tdsAcc = await this.accountsService.findByCode(wsId, firmId, '2014');
      lines.push({
        accountId: tdsAcc._id,
        accountCode: '2014',
        accountName: tdsAcc.name,
        debit: 0,
        credit: bill.tds194Q.tdsPaise,
      });
    }

    this.enforceInvariant(lines);

    const entry = new this.model({
      workspaceId: bill.workspaceId,
      firmId: bill.firmId,
      financialYear: bill.financialYear,
      entryDate: bill.voucherDate,
      entryType: 'purchase_bill',
      sourceVoucherId: bill._id,
      sourceVoucherType: 'purchase_bill',
      sourceVoucherNumber: bill.voucherNumber,
      narration: `Purchase from ${(bill.partySnapshot as any)?.name ?? 'vendor'}`,
      lines,
      isReversed: false,
      postedBy: new Types.ObjectId(userId),
      postedAt: new Date(),
      auditLog: [],
    });

    await entry.save({ session });
  }

  // ─── postPaymentOut ───────────────────────────────────────────────────────

  /**
   * Creates a balanced double-entry LedgerEntry for a posted PaymentOut.
   *
   * Journal:
   *   Dr  2001 Sundry Creditors         allocatedToCreditorsAfterTds94qPaise  [if > 0, with partyId]
   *   Dr  1005 Advance to Suppliers     unappliedPaise                         [if > 0]
   *     Cr  1001/1002 Cash/Bank         netPaidPaise
   *     Cr  2011/2012/2013 TDS Payable  tdsApplied.tdsPaise                    [if > 0]
   *
   * TDS section → account:  sec_194c→2011  sec_194h→2012  sec_194j→2013
   *
   * Invariant enforced before save.
   */
  async postPaymentOut(
    paymentOut: PaymentOut,
    opts: {
      session?: ClientSession;
      userId: string;
      firm: { _id: Types.ObjectId; workspaceId: Types.ObjectId };
    },
  ): Promise<void> {
    const { session, userId, firm } = opts;
    const wsId = firm.workspaceId.toString();
    const firmId = firm._id.toString();
    const lines: LedgerLine[] = [];

    // Dr 2001 Sundry Creditors — allocated against purchase bills (with partyId for party ledger)
    if (paymentOut.allocatedToCreditorsAfterTds94qPaise > 0) {
      const creditorsAcc = await this.accountsService.findByCode(wsId, firmId, '2001');
      lines.push({
        accountId: creditorsAcc._id,
        accountCode: '2001',
        accountName: creditorsAcc.name,
        debit: paymentOut.allocatedToCreditorsAfterTds94qPaise,
        credit: 0,
        partyId: paymentOut.partyId,
      });
    }

    // Dr 1005 Advance to Suppliers — unapplied amount (no matching bill)
    if (paymentOut.unappliedPaise > 0) {
      const advAcc = await this.accountsService.findByCode(wsId, firmId, '1005');
      lines.push({
        accountId: advAcc._id,
        accountCode: '1005',
        accountName: advAcc.name,
        debit: paymentOut.unappliedPaise,
        credit: 0,
        partyId: paymentOut.partyId,
      });
    }

    // Cr 1001 Cash / 1002 Bank — actual net amount paid to vendor
    const cashBankCode = paymentOut.paymentMode === 'cash' ? '1001' : '1002';
    const cashBankAcc = await this.accountsService.findByCode(wsId, firmId, cashBankCode);
    lines.push({
      accountId: cashBankAcc._id,
      accountCode: cashBankCode,
      accountName: cashBankAcc.name,
      debit: 0,
      credit: paymentOut.netPaidPaise,
    });

    // Cr TDS Payable section-specific account
    if (paymentOut.tdsApplied && paymentOut.tdsApplied.tdsPaise > 0) {
      const tdsCodeMap: Record<string, string> = {
        sec_194c: '2011',
        sec_194h: '2012',
        sec_194j: '2013',
      };
      const tdsCode = tdsCodeMap[paymentOut.tdsApplied.section];
      if (tdsCode) {
        const tdsAcc = await this.accountsService.findByCode(wsId, firmId, tdsCode);
        lines.push({
          accountId: tdsAcc._id,
          accountCode: tdsCode,
          accountName: tdsAcc.name,
          debit: 0,
          credit: paymentOut.tdsApplied.tdsPaise,
        });
      }
    }

    this.enforceInvariant(lines);

    const entry = new this.model({
      workspaceId: paymentOut.workspaceId,
      firmId: paymentOut.firmId,
      financialYear: paymentOut.financialYear,
      entryDate: paymentOut.paymentDate,
      entryType: 'payment_out',
      sourceVoucherId: paymentOut._id,
      sourceVoucherType: 'payment_out',
      sourceVoucherNumber: paymentOut.voucherNumber,
      narration: `Payment to ${(paymentOut.partySnapshot as any)?.name ?? 'vendor'}`,
      lines,
      isReversed: false,
      postedBy: new Types.ObjectId(userId),
      postedAt: new Date(),
      auditLog: [],
    });

    await entry.save({ session });
  }

  // ─── postCapitalGoodsItcRelease ───────────────────────────────────────────

  /**
   * Creates a balanced double-entry LedgerEntry for a monthly capital-goods ITC release.
   *
   * Journal (itcSplit='cgst_sgst'):
   *   Dr  1101 CGST Input Credit   cgstShare
   *   Dr  1102 SGST Input Credit   sgstShare
   *     Cr  1103 Capital Goods ITC Deferred   releasePaise
   *
   * Journal (itcSplit='igst'):
   *   Dr  1100 IGST Input Credit   releasePaise
   *     Cr  1103 Capital Goods ITC Deferred   releasePaise
   *
   * Invariant enforced before save.
   */
  async postCapitalGoodsItcRelease(
    schedule: CapitalGoodsItcSchedule,
    releasePaise: number,
    opts: { session?: ClientSession; userId: string },
  ): Promise<void> {
    if (releasePaise <= 0) {
      throw new InternalServerErrorException(
        `postCapitalGoodsItcRelease called with releasePaise=${releasePaise} — must be > 0`,
      );
    }
    const wsId = schedule.workspaceId.toString();
    const firmId = schedule.firmId.toString();
    const lines: LedgerLine[] = [];

    if (schedule.itcSplit === 'igst') {
      // Inter-state: Dr 1100 IGST Input Credit
      const igstAcc = await this.accountsService.findByCode(wsId, firmId, '1100');
      lines.push({
        accountId: igstAcc._id,
        accountCode: '1100',
        accountName: igstAcc.name,
        debit: releasePaise,
        credit: 0,
      });
    } else {
      // Intra-state: Dr 1101 + 1102 proportional split
      const cgstShare =
        schedule.totalItcPaise > 0
          ? Math.round(releasePaise * (schedule.cgstTotalPaise / schedule.totalItcPaise))
          : 0;
      const sgstShare = releasePaise - cgstShare;

      if (cgstShare > 0) {
        const cgstAcc = await this.accountsService.findByCode(wsId, firmId, '1101');
        lines.push({
          accountId: cgstAcc._id,
          accountCode: '1101',
          accountName: cgstAcc.name,
          debit: cgstShare,
          credit: 0,
        });
      }
      if (sgstShare > 0) {
        const sgstAcc = await this.accountsService.findByCode(wsId, firmId, '1102');
        lines.push({
          accountId: sgstAcc._id,
          accountCode: '1102',
          accountName: sgstAcc.name,
          debit: sgstShare,
          credit: 0,
        });
      }
    }

    // Cr 1103 Capital Goods ITC Deferred
    const capAcc = await this.accountsService.findByCode(wsId, firmId, '1103');
    lines.push({
      accountId: capAcc._id,
      accountCode: '1103',
      accountName: capAcc.name,
      debit: 0,
      credit: releasePaise,
    });

    this.enforceInvariant(lines);

    // Cron uses a sentinel ObjectId when no real userId is available
    const postedByOid =
      opts.userId === 'cron'
        ? new Types.ObjectId('000000000000000000000000')
        : new Types.ObjectId(opts.userId);

    const entry = new this.model({
      workspaceId: schedule.workspaceId,
      firmId: schedule.firmId,
      financialYear: schedule.financialYear,
      entryDate: new Date(),
      entryType: 'journal',
      sourceVoucherId: schedule._id,
      sourceVoucherType: 'capital_goods_itc_release',
      sourceVoucherNumber: `${schedule.sourceBillNumber}/CG-${schedule.monthsAmortised + 1}`,
      narration: `Capital goods ITC release ${schedule.monthsAmortised + 1}/60 for ${schedule.itemName}`,
      lines,
      isReversed: false,
      postedBy: postedByOid,
      postedAt: new Date(),
      auditLog: [],
    });

    await entry.save({ session: opts.session });
  }

  // ─── postDepreciation ─────────────────────────────────────────────────────

  /**
   * Post a depreciation entry: Dr 5009 Depreciation Expense / Cr 1510 Accumulated Depreciation
   * Called once per asset per period (month or quarter) by DepreciationRunService.
   *
   * Journal:
   *   Dr  5009 Depreciation              amountPaise
   *     Cr  1510 Less: Accumulated Dep   amountPaise
   *
   * Invariant: always balanced (2 equal lines).
   */
  async postDepreciation(
    asset: {
      _id: any;
      workspaceId: any;
      firmId: any;
      assetCode: string;
      name: string;
      depreciationMethod: string;
      financialYear: string;
    },
    amountPaise: number,
    runMonth: string, // YYYY-MM
    runId: any,
    entryDate: Date,
    options: { userId: string; session?: any },
  ): Promise<LedgerEntry> {
    if (amountPaise <= 0) {
      throw new InternalServerErrorException(
        `postDepreciation called with amountPaise=${amountPaise} — must be > 0`,
      );
    }
    const wsId = asset.workspaceId.toString();
    const firmId = asset.firmId.toString();

    // Resolve account IDs for codes 5009 (Depreciation Expense) and 1510 (Accumulated Depreciation)
    const [depAccount, accumAccount] = await Promise.all([
      this.accountsService.findByCode(wsId, firmId, '5009'),
      this.accountsService.findByCode(wsId, firmId, '1510'),
    ]);

    const narration = `Depreciation for ${runMonth}: ${asset.assetCode} ${asset.name} (${asset.depreciationMethod.toUpperCase()})`;

    const lines: LedgerLine[] = [
      {
        accountId: depAccount._id,
        accountCode: '5009',
        accountName: depAccount.name,
        debit: amountPaise,
        credit: 0,
      },
      {
        accountId: accumAccount._id,
        accountCode: '1510',
        accountName: accumAccount.name,
        debit: 0,
        credit: amountPaise,
      },
    ];

    this.enforceInvariant(lines);

    // Cron uses a sentinel ObjectId when no real userId is available
    const postedByOid =
      options.userId === 'cron'
        ? new Types.ObjectId('000000000000000000000000')
        : new Types.ObjectId(options.userId);

    const entry = new this.model({
      workspaceId: asset.workspaceId,
      firmId: asset.firmId,
      financialYear: asset.financialYear,
      entryDate,
      entryType: 'depreciation',
      sourceVoucherId: runId,
      sourceVoucherType: 'depreciation_run',
      sourceVoucherNumber: `DEP-${runMonth}-${asset.assetCode}`,
      narration,
      lines,
      isReversed: false,
      postedBy: postedByOid,
      postedAt: new Date(),
      auditLog: [],
    });

    return entry.save(options.session ? { session: options.session } : undefined);
  }

  // ─── postAssetDisposal ────────────────────────────────────────────────────

  /**
   * Post asset disposal/scrapping/write-off journal entry.
   *
   * Lines (built dynamically based on gain/loss sign):
   *   Dr 1510 Accumulated Depreciation   = asset.accumulatedDepreciationPaise
   *   Dr {cashOrBankAccountCode}          = disposalProceedsPaise  (omit if 0 — scrapping)
   *   Dr 5013 Loss on Disposal            = (NBV − proceeds)  if positive  (loss case)
   *   Cr {categorySnapshot.accountCode}   = asset.costPaise
   *   Cr 4007 Gain on Disposal            = (proceeds − NBV)  if positive  (gain case)
   *
   * Validates: sum(debits) === sum(credits).  Throws InternalServerErrorException on imbalance.
   */
  async postAssetDisposal(
    asset: {
      _id: any;
      workspaceId: any;
      firmId: any;
      assetCode: string;
      name: string;
      financialYear: string;
      costPaise: number;
      accumulatedDepreciationPaise: number;
      categorySnapshot?: Record<string, any>;
    },
    params: {
      disposalProceedsPaise: number;
      cashOrBankAccountCode: string | null;
      disposalDate: Date;
      userId: string;
      narration?: string;
      session?: ClientSession;
    },
  ): Promise<LedgerEntry> {
    const { disposalProceedsPaise, cashOrBankAccountCode, disposalDate, userId, narration } =
      params;
    const wsId = asset.workspaceId.toString();
    const firmId = asset.firmId.toString();
    const cost = asset.costPaise;
    const accumulated = asset.accumulatedDepreciationPaise;
    const nbv = cost - accumulated;
    const gainLoss = disposalProceedsPaise - nbv; // positive = gain, negative = loss
    const isGain = gainLoss > 0;
    const isLoss = gainLoss < 0;

    const fixedAssetCoaCode = asset.categorySnapshot?.accountCode;
    if (!fixedAssetCoaCode) {
      throw new InternalServerErrorException(
        `Asset ${asset.assetCode} missing categorySnapshot.accountCode — cannot post disposal`,
      );
    }

    // Resolve all CoA accounts needed
    const accumAccount = await this.accountsService.findByCode(wsId, firmId, '1510');
    const fixedAssetAccount = await this.accountsService.findByCode(
      wsId,
      firmId,
      fixedAssetCoaCode,
    );

    let cashAccount: any = null;
    if (disposalProceedsPaise > 0) {
      if (!cashOrBankAccountCode) {
        throw new InternalServerErrorException(
          'cashOrBankAccountCode required when disposalProceedsPaise > 0',
        );
      }
      cashAccount = await this.accountsService.findByCode(wsId, firmId, cashOrBankAccountCode);
    }

    const gainAccount = isGain ? await this.accountsService.findByCode(wsId, firmId, '4007') : null;
    const lossAccount = isLoss ? await this.accountsService.findByCode(wsId, firmId, '5013') : null;

    const lines: LedgerLine[] = [];

    // Dr 1510 Accumulated Depreciation (only if any depreciation has been posted)
    if (accumulated > 0) {
      lines.push({
        accountId: accumAccount._id,
        accountCode: '1510',
        accountName: accumAccount.name,
        debit: accumulated,
        credit: 0,
      });
    }

    // Dr cash/bank account (only if proceeds > 0 — no cash on scrapping)
    if (disposalProceedsPaise > 0) {
      lines.push({
        accountId: cashAccount._id as Types.ObjectId,
        accountCode: cashOrBankAccountCode,
        accountName: cashAccount.name,
        debit: disposalProceedsPaise,
        credit: 0,
      });
    }

    // Dr 5013 Loss on Disposal (only if proceeds < NBV)
    if (isLoss) {
      lines.push({
        accountId: lossAccount._id,
        accountCode: '5013',
        accountName: lossAccount.name,
        debit: -gainLoss, // gainLoss is negative; negate to get positive loss amount
        credit: 0,
      });
    }

    // Cr fixed asset account — full original cost
    lines.push({
      accountId: fixedAssetAccount._id,
      accountCode: fixedAssetCoaCode,
      accountName: fixedAssetAccount.name,
      debit: 0,
      credit: cost,
    });

    // Cr 4007 Gain on Disposal (only if proceeds > NBV)
    if (isGain) {
      lines.push({
        accountId: gainAccount._id,
        accountCode: '4007',
        accountName: gainAccount.name,
        debit: 0,
        credit: gainLoss,
      });
    }

    this.enforceInvariant(lines);

    const proceedsRupees = (disposalProceedsPaise / 100).toFixed(2);
    const nbvRupees = (nbv / 100).toFixed(2);
    const absGainLossRupees = (Math.abs(gainLoss) / 100).toFixed(2);
    const gainLossLabel = isGain ? 'Gain' : isLoss ? 'Loss' : 'No gain/loss';
    const finalNarration =
      narration ||
      `Asset disposal: ${asset.assetCode} ${asset.name}. Proceeds: ₹${proceedsRupees}. NBV: ₹${nbvRupees}. ${gainLossLabel}: ₹${absGainLossRupees}`;

    const postedByOid =
      userId === 'cron'
        ? new Types.ObjectId('000000000000000000000000')
        : new Types.ObjectId(userId);

    const entry = new this.model({
      workspaceId: asset.workspaceId,
      firmId: asset.firmId,
      financialYear: asset.financialYear,
      entryDate: disposalDate,
      entryType: 'asset_disposal',
      sourceVoucherId: asset._id,
      sourceVoucherType: 'fixed_asset',
      sourceVoucherNumber: asset.assetCode,
      narration: finalNarration,
      lines,
      isReversed: false,
      postedBy: postedByOid,
      postedAt: new Date(),
      auditLog: [],
    });

    return entry.save({ session: params.session });
  }

  /**
   * Finds the original (non-reversed) LedgerEntry for a source voucher.
   * Used by cancel() to locate the entry before reversing it.
   */
  async findBySourceVoucher(
    sourceVoucherId: Types.ObjectId,
    opts: { session?: ClientSession } = {},
  ): Promise<LedgerEntry | null> {
    return this.model
      .findOne({
        sourceVoucherId,
        sourceVoucherType: 'sale_invoice',
        isReversed: false,
      })
      .session(opts.session ?? null)
      .exec();
  }

  /**
   * Finds the original (non-reversed) expense LedgerEntry for an expense voucher.
   * Used by ExpensesService.cancel() to locate the entry before reversing.
   */
  async findExpenseEntry(
    sourceVoucherId: Types.ObjectId,
    session?: ClientSession,
  ): Promise<LedgerEntry | null> {
    return this.model
      .findOne({
        sourceVoucherId,
        sourceVoucherType: 'expense',
        isReversed: false,
      })
      .session(session ?? null)
      .exec();
  }

  /**
   * Marks a LedgerEntry as reversed (used by cancel flows after posting reversal).
   */
  async markEntryReversed(entryId: Types.ObjectId, session?: ClientSession): Promise<void> {
    await this.model.updateOne(
      { _id: entryId },
      { isReversed: true, reversedAt: new Date() },
      { session },
    );
  }

  /**
   * Reverses a previously posted LedgerEntry (swap debit/credit on all lines).
   * Used by Credit Note (F-07) and 24h cancel path.
   */
  async postSaleInvoiceReverse(
    originalEntry: LedgerEntry,
    opts: { session?: ClientSession; userId: string },
  ): Promise<LedgerEntry> {
    const reversedLines: LedgerLine[] = originalEntry.lines.map((l) => ({
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountName: l.accountName,
      debit: l.credit,
      credit: l.debit,
      partyId: l.partyId,
    }));

    const reverseEntry = new this.model({
      workspaceId: originalEntry.workspaceId,
      firmId: originalEntry.firmId,
      financialYear: originalEntry.financialYear,
      entryDate: new Date(),
      entryType: 'sale_invoice_reverse',
      sourceVoucherId: originalEntry.sourceVoucherId,
      sourceVoucherType: originalEntry.sourceVoucherType,
      sourceVoucherNumber: originalEntry.sourceVoucherNumber,
      narration: `Reversal of ${originalEntry.narration}`,
      lines: reversedLines,
      isReversed: false,
      postedBy: new Types.ObjectId(opts.userId),
      postedAt: new Date(),
      auditLog: [],
    });

    const saved = await reverseEntry.save({ session: opts.session });

    // Mark original as reversed
    await this.model.updateOne(
      { _id: originalEntry._id },
      { isReversed: true, reversedBy: saved._id, reversedAt: new Date() },
      { session: opts.session },
    );

    return saved;
  }

  // ─── Private helpers for building LedgerLine objects ────────────────────────

  // Does a CoA code exist (non-deleted) for this firm? Lets a posting fall back to a default
  // ledger when a process-specific account isn't seeded (e.g. non-textile firms lack 4021/4024).
  private async accountExists(wsId: string, firmId: string, code: string): Promise<boolean> {
    const exists = await this.accountModel.exists({
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      code,
      isDeleted: false,
    });
    return exists != null;
  }

  private async makeDebitLine(
    firm: { _id: Types.ObjectId; workspaceId: Types.ObjectId },
    code: string,
    amount: number,
    partyId?: Types.ObjectId,
  ): Promise<LedgerLine> {
    const acc = await this.accountsService.findByCode(
      firm.workspaceId.toString(),
      firm._id.toString(),
      code,
    );
    return {
      accountId: acc._id,
      accountCode: code,
      accountName: acc.name,
      debit: amount,
      credit: 0,
      partyId,
    };
  }

  private async makeCreditLine(
    firm: { _id: Types.ObjectId; workspaceId: Types.ObjectId },
    code: string,
    amount: number,
    partyId?: Types.ObjectId,
  ): Promise<LedgerLine> {
    const acc = await this.accountsService.findByCode(
      firm.workspaceId.toString(),
      firm._id.toString(),
      code,
    );
    return {
      accountId: acc._id,
      accountCode: code,
      accountName: acc.name,
      debit: 0,
      credit: amount,
      partyId,
    };
  }

  // ─── postExpenseVoucher ───────────────────────────────────────────────────

  /**
   * Creates a balanced double-entry LedgerEntry for a posted ExpenseVoucher.
   *
   * Journal (itcEligibility='full' lines):
   *   Dr  expense-account-code    amountPaise (taxable only)
   *   Dr  1101/1102 CGST/SGST Input Credit   cgstPaise / sgstPaise  (intra-state)
   *   Dr  1100 IGST Input Credit             igstPaise              (inter-state)
   *
   * Journal (itcEligibility='blocked' or 'nil_rated' lines):
   *   Dr  expense-account-code    lineTotalPaise (gross — GST baked in)
   *
   * Credit side:
   *   Cr  1001/1002 Cash/Bank    netPayablePaise  (net of TDS)
   *   Cr  2011/2012/2013 TDS Payable   tdsPaise   [if TDS applied]
   *
   * Invariant: sum(debit) === sum(credit)
   */
  async postExpenseVoucher(
    voucher: ExpenseVoucher,
    opts: PostExpenseVoucherOptions,
  ): Promise<LedgerEntry> {
    const { firm, userId, session } = opts;
    const lines: LedgerLine[] = [];

    // 1. Debit each expense account line
    for (const line of voucher.lineItems) {
      // For itcEligibility='full': debit only the taxable amount (GST goes to ITC accounts)
      // For 'blocked' or 'nil_rated': debit the full gross (GST baked into expense)
      const debit = line.itcEligibility === 'full' ? line.amountPaise : line.lineTotalPaise;
      lines.push({
        accountId: line.expenseAccountId,
        accountCode: line.expenseAccountCode,
        accountName: line.expenseAccountName,
        debit,
        credit: 0,
        partyId: voucher.partyId,
      });
    }

    // 2. ITC debit lines — only for itcEligibility='full' lines
    let totalCgst = 0;
    let totalSgst = 0;
    let totalIgst = 0;
    for (const line of voucher.lineItems) {
      if (line.itcEligibility !== 'full') continue;
      totalCgst += line.cgstPaise ?? 0;
      totalSgst += line.sgstPaise ?? 0;
      totalIgst += line.igstPaise ?? 0;
    }

    if (voucher.isIntraState) {
      if (totalCgst > 0) {
        lines.push(await this.makeDebitLine(firm, CODE_CGST_INPUT, totalCgst));
      }
      if (totalSgst > 0) {
        lines.push(await this.makeDebitLine(firm, CODE_SGST_INPUT, totalSgst));
      }
    } else {
      if (totalIgst > 0) {
        lines.push(await this.makeDebitLine(firm, CODE_IGST_INPUT, totalIgst));
      }
    }

    // 3. TDS credit (if applied) — section-specific payable accounts
    if (voucher.tdsApplied && voucher.tdsApplied.tdsPaise > 0) {
      const sectionToCode: Record<string, string> = {
        sec_194c: CODE_TDS_PAY_194C,
        sec_194h: CODE_TDS_PAY_194H,
        sec_194j: CODE_TDS_PAY_194J,
        sec_194m: CODE_TDS_PAY_194C, // 194M routes through 194C account
      };
      const tdsCode = sectionToCode[voucher.tdsApplied.section];
      if (tdsCode) {
        lines.push(
          await this.makeCreditLine(firm, tdsCode, voucher.tdsApplied.tdsPaise, voucher.partyId),
        );
      }
    }

    // 4. Cash/Bank credit — net of TDS
    const payCode = voucher.paymentMode === 'cash' ? CODE_CASH : CODE_BANK;
    lines.push(await this.makeCreditLine(firm, payCode, voucher.netPayablePaise, voucher.partyId));

    // 5. Enforce balanced invariant
    this.enforceInvariant(lines);

    // 6. Persist
    const entry = new this.model({
      workspaceId: firm.workspaceId,
      firmId: firm._id,
      financialYear: voucher.financialYear,
      entryDate: voucher.voucherDate,
      entryType: 'expense',
      sourceVoucherId: voucher._id,
      sourceVoucherType: 'expense',
      sourceVoucherNumber: voucher.voucherNumber ?? '',
      narration: voucher.narration || `Expense ${voucher.voucherNumber ?? ''}`,
      lines,
      isReversed: false,
      postedBy: new Types.ObjectId(userId),
      postedAt: new Date(),
      auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'post' }],
    });

    return entry.save({ session });
  }

  // ─── postExpenseReversal ──────────────────────────────────────────────────

  /**
   * Creates a balanced reversal LedgerEntry for a cancelled ExpenseVoucher.
   * All debit/credit lines are flipped from the original entry.
   * Uses sourceVoucherType='expense_reversal' (distinct from 'expense')
   * to allow both records under the unique (wsId, firmId, sourceVoucherId, sourceVoucherType) index.
   */
  async postExpenseReversal(
    voucher: ExpenseVoucher,
    originalEntry: LedgerEntry,
    opts: PostExpenseVoucherOptions,
  ): Promise<LedgerEntry> {
    const { firm, userId, session } = opts;

    const flippedLines: LedgerLine[] = originalEntry.lines.map((l) => ({
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountName: l.accountName,
      debit: l.credit,
      credit: l.debit,
      partyId: l.partyId,
    }));

    this.enforceInvariant(flippedLines);

    const reversal = new this.model({
      workspaceId: firm.workspaceId,
      firmId: firm._id,
      financialYear: voucher.financialYear,
      entryDate: new Date(),
      entryType: 'expense_reversal',
      sourceVoucherId: voucher._id,
      // Distinct sourceVoucherType → unique-index safe (T-F06W2-08)
      sourceVoucherType: 'expense_reversal',
      sourceVoucherNumber: (voucher.voucherNumber ?? '') + '-REV',
      narration: `Reversal: ${voucher.narration || ''}`,
      lines: flippedLines,
      isReversed: false,
      postedBy: new Types.ObjectId(userId),
      postedAt: new Date(),
      auditLog: [
        {
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'cancel_reversal',
        },
      ],
    });

    return reversal.save({ session });
  }

  // ─── postContraEntry ──────────────────────────────────────────────────────

  /**
   * Creates a balanced contra entry (e.g. cash→bank or bank→cash transfer).
   * Called by Wave 3 CashBankTransfer controller.
   *
   * Journal:
   *   Dr  toCode    amountPaise
   *     Cr  fromCode  amountPaise
   *
   * Invariant: always balanced (2 equal lines).
   */
  async postContraEntry(
    fromCode: string,
    toCode: string,
    amountPaise: number,
    narration: string,
    opts: PostContraEntryOptions,
  ): Promise<LedgerEntry> {
    const drLine = await this.makeDebitLine(opts.firm, toCode, amountPaise);
    const crLine = await this.makeCreditLine(opts.firm, fromCode, amountPaise);
    this.enforceInvariant([drLine, crLine]);

    const entry = new this.model({
      workspaceId: opts.firm.workspaceId,
      firmId: opts.firm._id,
      financialYear: opts.financialYear,
      entryDate: opts.voucherDate,
      entryType: 'contra',
      sourceVoucherId: opts.voucherId,
      sourceVoucherType: 'contra',
      sourceVoucherNumber: opts.voucherNumber,
      narration,
      lines: [drLine, crLine],
      isReversed: false,
      postedBy: new Types.ObjectId(opts.userId),
      postedAt: new Date(),
      auditLog: [],
    });

    return entry.save({ session: opts.session });
  }

  // ─── postWastageEntry ─────────────────────────────────────────────────────

  /**
   * D-06 Wastage entry ledger posting.
   *
   * Returns null when ownGoodsTotalPaise === 0 (job_work_material-only wastage —
   * no own-goods value to expense, so no ledger entry is created per D-06 spec).
   *
   * Otherwise posts a balanced double-entry:
   *   Dr 5018 Wastage & Damage Expense   ownGoodsTotalPaise
   *     Cr 1004 Stock (Current Assets)   ownGoodsTotalPaise
   */
  async postWastageEntry(
    wastage: WastageEntryDocument,
    ownGoodsTotalPaise: number,
    session?: ClientSession,
  ): Promise<LedgerEntry | null> {
    if (ownGoodsTotalPaise <= 0) {
      return null;
    }

    const firm = {
      _id: wastage.firmId,
      workspaceId: wastage.workspaceId,
    };

    // Indian financial year (April–March) inline derivation from wastage.date
    const d = wastage.date;
    const yr = d.getFullYear();
    const mo = d.getMonth() + 1;
    const fyStart = mo >= 4 ? yr : yr - 1;
    const financialYear = `${fyStart}-${String(fyStart + 1).slice(-2)}`;

    const drLine = await this.makeDebitLine(firm, CODE_WASTAGE_EXPENSE, ownGoodsTotalPaise);
    const crLine = await this.makeCreditLine(firm, CODE_STOCK, ownGoodsTotalPaise);

    this.enforceInvariant([drLine, crLine]);

    const entry = new this.model({
      workspaceId: wastage.workspaceId,
      firmId: wastage.firmId,
      financialYear,
      entryDate: wastage.date,
      entryType: 'wastage_entry',
      sourceVoucherId: wastage._id,
      sourceVoucherType: 'wastage_entry',
      sourceVoucherNumber: wastage.voucherNo,
      narration: `Wastage entry ${wastage.voucherNo}`,
      lines: [drLine, crLine],
      isReversed: false,
      postedBy: wastage.postedBy ?? new Types.ObjectId('000000000000000000000000'),
      postedAt: new Date(),
      auditLog: [],
    });

    return entry.save({ session });
  }

  // ─── postJournalVoucher ───────────────────────────────────────────────────

  /**
   * Creates a balanced double-entry LedgerEntry for a posted JournalVoucher.
   * Maps JV lines 1:1 — debitPaise -> debit, creditPaise -> credit.
   * Sets entryType='journal' or 'contra' based on voucher.voucherType.
   * Enforces balanced invariant as defence-in-depth (T-F06W3-01).
   */
  async postJournalVoucher(
    voucher: JournalVoucher,
    opts: PostExpenseVoucherOptions,
  ): Promise<LedgerEntry> {
    const { firm, userId, session } = opts;

    const lines: LedgerLine[] = voucher.lines.map((l) => ({
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountName: l.accountName,
      debit: l.debitPaise,
      credit: l.creditPaise,
      partyId: l.partyId,
    }));

    // Defence-in-depth: enforce balance even though service already validated (T-F06W3-01)
    this.enforceInvariant(lines);

    // voucherType='contra' -> entryType='contra'; anything else -> 'journal'
    const entryType = voucher.voucherType === 'contra' ? 'contra' : 'journal';

    const entry = new this.model({
      workspaceId: firm.workspaceId,
      firmId: firm._id,
      financialYear: voucher.financialYear,
      entryDate: voucher.voucherDate,
      entryType,
      sourceVoucherId: voucher._id,
      sourceVoucherType: voucher.voucherType,
      sourceVoucherNumber: voucher.voucherNumber ?? '',
      narration: voucher.narration,
      lines,
      isReversed: false,
      postedBy: new Types.ObjectId(userId),
      postedAt: new Date(),
      auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'post' }],
    });

    return entry.save({ session });
  }

  /**
   * Generic balanced journal post for callers that DON'T have a JournalVoucher document - e.g. the
   * late-fee / vyaj accrual cron (late-fee.service). Routes those entries through the same central
   * guarantees as every other posting: the zero-sum invariant is enforced and a standard
   * LedgerEntry is built (entryType='journal'), so cron-generated entries can't silently go
   * unbalanced. Keep in sync with postJournalVoucher's entry shape.
   */
  async postManualJournal(
    params: {
      workspaceId: Types.ObjectId;
      firmId: Types.ObjectId;
      financialYear: string;
      entryDate: Date;
      sourceVoucherId?: Types.ObjectId;
      sourceVoucherType: string;
      sourceVoucherNumber: string;
      narration: string;
      lines: LedgerLine[];
    },
    opts: { userId: string; session?: ClientSession },
  ): Promise<LedgerEntry> {
    // Defence-in-depth: a manual/cron caller is exactly where an unbalanced entry could slip in.
    this.enforceInvariant(params.lines);

    const postedBy = new Types.ObjectId(opts.userId);
    const entry = new this.model({
      workspaceId: params.workspaceId,
      firmId: params.firmId,
      financialYear: params.financialYear,
      entryDate: params.entryDate,
      entryType: 'journal',
      sourceVoucherId: params.sourceVoucherId,
      sourceVoucherType: params.sourceVoucherType,
      sourceVoucherNumber: params.sourceVoucherNumber,
      narration: params.narration,
      lines: params.lines,
      isReversed: false,
      postedBy,
      postedAt: new Date(),
      auditLog: [{ at: new Date(), by: postedBy, action: 'post' }],
    });

    return entry.save({ session: opts.session });
  }

  // ─── postJournalReversal ──────────────────────────────────────────────────

  /**
   * Creates a balanced reversal LedgerEntry for a cancelled JournalVoucher.
   * Flips all debit/credit lines from the original entry.
   * Uses sourceVoucherType='journal_reversal' or 'contra_reversal' — distinct from original,
   * satisfying the unique (wsId, firmId, sourceVoucherId, sourceVoucherType) index (T-F06W3-01).
   */
  async postJournalReversal(
    voucher: JournalVoucher,
    originalEntry: LedgerEntry,
    opts: PostExpenseVoucherOptions,
  ): Promise<LedgerEntry> {
    const { firm, userId, session } = opts;

    const flipped: LedgerLine[] = originalEntry.lines.map((l) => ({
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountName: l.accountName,
      debit: l.credit,
      credit: l.debit,
      partyId: l.partyId,
    }));

    this.enforceInvariant(flipped);

    // Distinct sourceVoucherType so it doesn't collide with original entry under unique index
    const reversalVoucherType =
      voucher.voucherType === 'contra' ? 'contra_reversal' : 'journal_reversal';

    const reversal = new this.model({
      workspaceId: firm.workspaceId,
      firmId: firm._id,
      financialYear: voucher.financialYear,
      entryDate: new Date(),
      entryType: voucher.voucherType === 'contra' ? 'contra' : 'journal',
      sourceVoucherId: voucher._id,
      sourceVoucherType: reversalVoucherType,
      sourceVoucherNumber: (voucher.voucherNumber ?? '') + '-REV',
      narration: `Reversal: ${voucher.narration}`,
      lines: flipped,
      isReversed: false,
      postedBy: new Types.ObjectId(userId),
      postedAt: new Date(),
      auditLog: [
        {
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'cancel_reversal',
        },
      ],
    });

    return reversal.save({ session });
  }

  // ─── findJournalEntry ─────────────────────────────────────────────────────

  /**
   * Finds the original (non-reversed) LedgerEntry for a JournalVoucher.
   * Searches for sourceVoucherType IN ['journal', 'contra'] since the JV
   * voucherType drives the entry type — used by cancel() flow.
   */
  async findJournalEntry(
    sourceVoucherId: Types.ObjectId,
    session?: ClientSession,
  ): Promise<LedgerEntry | null> {
    return this.model
      .findOne({
        sourceVoucherId,
        sourceVoucherType: { $in: ['journal', 'contra'] },
        isReversed: false,
      })
      .session(session ?? null)
      .exec();
  }

  // ─── postLoanDisbursement ─────────────────────────────────────────────────

  /**
   * Posts a loan disbursement entry — funds received from lender into bank account.
   *
   * Journal:
   *   Dr  bankCoaCode           disbursedAmountPaise  (bank receives funds)
   *     Cr  loanLiabilityCode   disbursedAmountPaise  (loan liability created)
   *
   * Invariant: always balanced (equal Dr/Cr).
   *
   * sourceVoucherType = 'loan_account' (matches VoucherSeries enum).
   */
  async postLoanDisbursement(
    params: {
      loanAccountId: Types.ObjectId;
      loanCode: string;
      workspaceId: Types.ObjectId;
      firmId: Types.ObjectId;
      financialYear: string;
      disbursementDate: Date;
      disbursedAmountPaise: number;
      bankCoaCode: string;
      loanLiabilityCode: string;
      narration?: string;
    },
    opts: { session?: ClientSession; userId: string },
  ): Promise<LedgerEntry> {
    const wsId = params.workspaceId.toString();
    const firmId = params.firmId.toString();

    const [bankAcc, liabilityAcc] = await Promise.all([
      this.accountsService.findByCode(wsId, firmId, params.bankCoaCode),
      this.accountsService.findByCode(wsId, firmId, params.loanLiabilityCode),
    ]);

    const lines: LedgerLine[] = [
      {
        accountId: bankAcc._id,
        accountCode: params.bankCoaCode,
        accountName: bankAcc.name,
        debit: params.disbursedAmountPaise,
        credit: 0,
      },
      {
        accountId: liabilityAcc._id,
        accountCode: params.loanLiabilityCode,
        accountName: liabilityAcc.name,
        debit: 0,
        credit: params.disbursedAmountPaise,
      },
    ];

    this.enforceInvariant(lines);

    const postedByOid =
      opts.userId === 'cron'
        ? new Types.ObjectId('000000000000000000000000')
        : new Types.ObjectId(opts.userId);

    const entry = new this.model({
      workspaceId: params.workspaceId,
      firmId: params.firmId,
      financialYear: params.financialYear,
      entryDate: params.disbursementDate,
      entryType: 'loan_disbursement',
      sourceVoucherId: params.loanAccountId,
      sourceVoucherType: 'loan_account',
      sourceVoucherNumber: params.loanCode,
      narration: params.narration ?? `Loan disbursement: ${params.loanCode}`,
      lines,
      isReversed: false,
      postedBy: postedByOid,
      postedAt: new Date(),
      auditLog: [],
    });

    return entry.save({ session: opts.session });
  }

  // ─── postLoanEmi ──────────────────────────────────────────────────────────

  /**
   * Posts a single EMI payment entry for a loan schedule entry.
   *
   * Journal:
   *   Dr  loanLiabilityCode   principalComponentPaise  (reduces outstanding principal)
   *   Dr  5015 Interest on Loan  interestComponentPaise (interest expense)
   *     Cr  bankCoaCode       emiAmountPaise            (total EMI paid from bank)
   *
   * CRITICAL (Pitfall 5): sourceVoucherId is the LoanScheduleEntry._id (NOT loanAccountId).
   * This prevents unique-index collisions across monthly EMI entries for the same loan.
   *
   * sourceVoucherType = 'loan_emi'
   * entryType = 'loan_emi'
   *
   * Invariant: sum(debit) === sum(credit)
   */
  async postLoanEmi(
    params: {
      scheduleEntryId: Types.ObjectId; // _id of LoanScheduleEntry (unique per month)
      loanCode: string;
      month: string; // YYYY-MM
      workspaceId: Types.ObjectId;
      firmId: Types.ObjectId;
      financialYear: string;
      emiDate: Date;
      emiAmountPaise: number;
      principalComponentPaise: number;
      interestComponentPaise: number;
      bankCoaCode: string;
      loanLiabilityCode: string;
    },
    opts: { session?: ClientSession; userId: string },
  ): Promise<LedgerEntry> {
    const wsId = params.workspaceId.toString();
    const firmId = params.firmId.toString();

    const [liabilityAcc, interestAcc, bankAcc] = await Promise.all([
      this.accountsService.findByCode(wsId, firmId, params.loanLiabilityCode),
      this.accountsService.findByCode(wsId, firmId, CODE_INTEREST_ON_LOAN),
      this.accountsService.findByCode(wsId, firmId, params.bankCoaCode),
    ]);

    const lines: LedgerLine[] = [];

    // Dr loan liability — principal component reduces outstanding
    if (params.principalComponentPaise > 0) {
      lines.push({
        accountId: liabilityAcc._id,
        accountCode: params.loanLiabilityCode,
        accountName: liabilityAcc.name,
        debit: params.principalComponentPaise,
        credit: 0,
      });
    }

    // Dr 5015 Interest on Loan — interest component
    if (params.interestComponentPaise > 0) {
      lines.push({
        accountId: interestAcc._id,
        accountCode: CODE_INTEREST_ON_LOAN,
        accountName: interestAcc.name,
        debit: params.interestComponentPaise,
        credit: 0,
      });
    }

    // Cr bank account — total EMI debited from bank
    lines.push({
      accountId: bankAcc._id,
      accountCode: params.bankCoaCode,
      accountName: bankAcc.name,
      debit: 0,
      credit: params.emiAmountPaise,
    });

    this.enforceInvariant(lines);

    const postedByOid =
      opts.userId === 'cron'
        ? new Types.ObjectId('000000000000000000000000')
        : new Types.ObjectId(opts.userId);

    const entry = new this.model({
      workspaceId: params.workspaceId,
      firmId: params.firmId,
      financialYear: params.financialYear,
      entryDate: params.emiDate,
      entryType: 'loan_emi',
      sourceVoucherId: params.scheduleEntryId, // LoanScheduleEntry._id — unique per month
      sourceVoucherType: 'loan_emi',
      sourceVoucherNumber: `${params.loanCode}/${params.month}`,
      narration: `Loan EMI ${params.month}: ${params.loanCode} — Principal ₹${(params.principalComponentPaise / 100).toFixed(2)} + Interest ₹${(params.interestComponentPaise / 100).toFixed(2)}`,
      lines,
      isReversed: false,
      postedBy: postedByOid,
      postedAt: new Date(),
      auditLog: [],
    });

    return entry.save({ session: opts.session });
  }

  // ─── postCreditNote ───────────────────────────────────────────────────────

  /**
   * Post a Credit Note ledger entry (Sale Return).
   *
   * Intra-state: Dr 4001 Sales (taxableValue), Dr 2007 CGST Payable, Dr 2008 SGST Payable,
   *              Cr 1003 Sundry Debtors (capped at invoiceAmountDuePaise)
   * Inter-state: Dr 4001 Sales, Dr 2006 IGST Payable,
   *              Cr 1003 Sundry Debtors (capped at invoiceAmountDuePaise)
   * Refund split: when grandTotalPaise > invoiceAmountDuePaise, excess is
   *              Cr 2002 Advance from Customers (refund obligation) — Edge Case 1.
   *
   * Uses entryType='credit_note', sourceVoucherType='credit_note'.
   * The unique index (workspaceId, firmId, sourceVoucherId, sourceVoucherType) is satisfied
   * because cancellation reversal uses sourceVoucherType='credit_note_reversal' (distinct).
   */
  async postCreditNote(
    creditNote: CreditNote,
    invoiceAmountDuePaise: number,
    opts: {
      session?: ClientSession;
      userId: string;
      firm: { _id: Types.ObjectId; workspaceId: Types.ObjectId };
    },
  ): Promise<LedgerEntry> {
    const { session, userId, firm } = opts;

    const lines: LedgerLine[] = [];

    if (creditNote.isCommercial) {
      // D11: commercial / financial credit note (kasar-vatav) - NO GST reversal. The whole
      // value is a commercial discount posted to 5026 Kasar-Vatav Allowed, reducing the
      // customer's dues (5026 is seeded for textile firms).
      lines.push(await this.makeDebitLine(firm, '5026', creditNote.grandTotalPaise));
    } else {
      // Debit side: reverse revenue + reverse GST output liability.
      // #14: route the revenue reversal to the Sales Returns contra-revenue account (4009) so gross
      // Sales (4001) stays visible and returns report separately (net sales = 4001 - 4009). Falls
      // back to 4001 for firms whose CoA predates the 4009 seed (the additive seed backfills the rest).
      const returnsCode = (await this.accountExists(
        firm.workspaceId.toString(),
        firm._id.toString(),
        CODE_SALES_RETURNS,
      ))
        ? CODE_SALES_RETURNS
        : CODE_SALES;
      lines.push(await this.makeDebitLine(firm, returnsCode, creditNote.taxableValuePaise));

      if (creditNote.isIntraState) {
        if (creditNote.cgstPaise > 0) {
          lines.push(await this.makeDebitLine(firm, CODE_CGST_PAY, creditNote.cgstPaise));
        }
        if (creditNote.sgstPaise > 0) {
          lines.push(await this.makeDebitLine(firm, CODE_SGST_PAY, creditNote.sgstPaise));
        }
      } else {
        if (creditNote.igstPaise > 0) {
          lines.push(await this.makeDebitLine(firm, CODE_IGST_PAY, creditNote.igstPaise));
        }
      }
    }

    // Credit side: reduce party outstanding (capped at amountDue), excess to Advance from Customers
    const debtorReductionPaise = Math.min(
      creditNote.grandTotalPaise,
      Math.max(0, invoiceAmountDuePaise),
    );
    const refundPaise = Math.max(0, creditNote.grandTotalPaise - invoiceAmountDuePaise);

    if (debtorReductionPaise > 0) {
      lines.push(
        await this.makeCreditLine(firm, CODE_DEBTORS, debtorReductionPaise, creditNote.partyId),
      );
    }
    if (refundPaise > 0) {
      lines.push(
        await this.makeCreditLine(
          firm,
          CODE_ADVANCE_FROM_CUSTOMERS,
          refundPaise,
          creditNote.partyId,
        ),
      );
    }

    this.enforceInvariant(lines);

    const entry = new this.model({
      workspaceId: firm.workspaceId,
      firmId: firm._id,
      financialYear: creditNote.financialYear,
      entryDate: creditNote.voucherDate,
      entryType: 'credit_note',
      sourceVoucherId: creditNote._id,
      sourceVoucherType: 'credit_note',
      sourceVoucherNumber: creditNote.voucherNumber,
      narration:
        creditNote.narration ??
        `Credit Note ${creditNote.voucherNumber} against ${creditNote.sourceInvoiceNumber}`,
      lines,
      isReversed: false,
      postedBy: new Types.ObjectId(userId),
      postedAt: new Date(),
      auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'post' }],
    });

    await entry.save({ session });
    return entry;
  }

  // ─── postCreditNoteReversal ───────────────────────────────────────────────

  /**
   * Post a reversal of a Credit Note (when the CN is cancelled).
   * Flips all debit↔credit lines from the original entry, saves as a new entry with
   * sourceVoucherType='credit_note_reversal' (distinct from 'credit_note') to satisfy
   * the unique index (T-F07W2-08).
   * Marks the original entry isReversed=true.
   */
  async postCreditNoteReversal(
    creditNote: CreditNote,
    originalEntry: LedgerEntry,
    opts: {
      session?: ClientSession;
      userId: string;
      firm: { _id: Types.ObjectId; workspaceId: Types.ObjectId };
    },
  ): Promise<LedgerEntry> {
    const { session, userId, firm } = opts;

    const flippedLines: LedgerLine[] = originalEntry.lines.map((l) => ({
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountName: l.accountName,
      debit: l.credit,
      credit: l.debit,
      partyId: l.partyId,
    }));

    this.enforceInvariant(flippedLines);

    const reversedEntry = new this.model({
      workspaceId: firm.workspaceId,
      firmId: firm._id,
      financialYear: creditNote.financialYear,
      entryDate: new Date(),
      entryType: 'credit_note_reversal',
      sourceVoucherId: creditNote._id,
      // Distinct sourceVoucherType → unique-index safe (T-F07W2-08)
      sourceVoucherType: 'credit_note_reversal',
      sourceVoucherNumber: (creditNote.voucherNumber ?? '') + '-REV',
      narration: `Reversal of Credit Note ${creditNote.voucherNumber} (cancelled)`,
      lines: flippedLines,
      isReversed: false,
      postedBy: new Types.ObjectId(userId),
      postedAt: new Date(),
      auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'post_reversal' }],
    });

    await reversedEntry.save({ session });

    // Mark original entry as reversed
    await this.model.updateOne(
      { _id: originalEntry._id },
      {
        $set: {
          isReversed: true,
          reversedBy: new Types.ObjectId(userId),
          reversedAt: new Date(),
        },
      },
      { session },
    );

    return reversedEntry;
  }

  // ─── postDebitNote ────────────────────────────────────────────────────────

  /**
   * Post a Debit Note ledger entry (Purchase Return).
   *
   * Standard intra-state: Dr 2001 Sundry Creditors (grandTotal), Cr 5001 Purchases (taxableValue),
   *                        Cr 1101 CGST Input Credit, Cr 1102 SGST Input Credit
   * Standard inter-state: Dr 2001 Sundry Creditors, Cr 5001 Purchases, Cr 1100 IGST Input Credit
   * Capital goods lines: ITC routes to 1103 Capital Goods ITC Deferred (NOT 1100/1101/1102) per Edge Case 4.
   *
   * Uses entryType='debit_note', sourceVoucherType='debit_note'.
   * Cancellation reversal uses sourceVoucherType='debit_note_reversal' (distinct).
   */
  async postDebitNote(
    debitNote: DebitNote,
    opts: {
      session?: ClientSession;
      userId: string;
      firm: { _id: Types.ObjectId; workspaceId: Types.ObjectId };
    },
  ): Promise<LedgerEntry> {
    const { session, userId, firm } = opts;

    // Split lines into capital-goods bucket and regular bucket (RESEARCH 4.2 Edge Case 4)
    const capitalLines = debitNote.lineItems.filter((l: any) => l.isCapitalGoods === true);
    const regularLines = debitNote.lineItems.filter((l: any) => l.isCapitalGoods !== true);

    const sumPaise = (arr: any[], key: string) => arr.reduce((s, l) => s + (l[key] ?? 0), 0);

    const capitalTaxable = sumPaise(capitalLines, 'taxableValuePaise');
    const capitalCgst = sumPaise(capitalLines, 'cgstPaise');
    const capitalSgst = sumPaise(capitalLines, 'sgstPaise');
    const capitalIgst = sumPaise(capitalLines, 'igstPaise');
    const capitalGstTotal = capitalCgst + capitalSgst + capitalIgst;

    const regularTaxable = sumPaise(regularLines, 'taxableValuePaise');
    const regularCgst = sumPaise(regularLines, 'cgstPaise');
    const regularSgst = sumPaise(regularLines, 'sgstPaise');
    const regularIgst = sumPaise(regularLines, 'igstPaise');

    const lines: LedgerLine[] = [];

    // Debit side: vendor payable reduces by full grand total
    lines.push(
      await this.makeDebitLine(firm, '2001', debitNote.grandTotalPaise, debitNote.partyId),
    );

    // Credit side: purchases reduce (combined capital + regular taxable)
    if (regularTaxable + capitalTaxable > 0) {
      lines.push(await this.makeCreditLine(firm, '5001', regularTaxable + capitalTaxable));
    }

    // Credit side: ITC reversal — REGULAR lines route to 1100/1101/1102
    if (debitNote.isIntraState) {
      if (regularCgst > 0) lines.push(await this.makeCreditLine(firm, '1101', regularCgst));
      if (regularSgst > 0) lines.push(await this.makeCreditLine(firm, '1102', regularSgst));
    } else {
      if (regularIgst > 0) lines.push(await this.makeCreditLine(firm, '1100', regularIgst));
    }

    // Credit side: ITC reversal — CAPITAL GOODS lines route to 1103 Capital Goods ITC Deferred
    if (capitalGstTotal > 0) {
      lines.push(await this.makeCreditLine(firm, '1103', capitalGstTotal));
    }

    this.enforceInvariant(lines);

    const entry = new this.model({
      workspaceId: firm.workspaceId,
      firmId: firm._id,
      financialYear: debitNote.financialYear,
      entryDate: debitNote.voucherDate,
      entryType: 'debit_note',
      sourceVoucherId: debitNote._id,
      sourceVoucherType: 'debit_note',
      sourceVoucherNumber: debitNote.voucherNumber,
      narration:
        debitNote.narration ??
        `Debit Note ${debitNote.voucherNumber} against ${debitNote.sourceBillNumber}`,
      lines,
      isReversed: false,
      postedBy: new Types.ObjectId(userId),
      postedAt: new Date(),
      auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'post' }],
    });

    await entry.save({ session });
    return entry;
  }

  // ─── postDebitNoteReversal ────────────────────────────────────────────────

  /**
   * Post a reversal of a Debit Note (when DN is cancelled).
   * Uses sourceVoucherType='debit_note_reversal' (distinct from 'debit_note') to satisfy unique index.
   */
  async postDebitNoteReversal(
    debitNote: DebitNote,
    originalEntry: LedgerEntry,
    opts: {
      session?: ClientSession;
      userId: string;
      firm: { _id: Types.ObjectId; workspaceId: Types.ObjectId };
    },
  ): Promise<LedgerEntry> {
    const { session, userId, firm } = opts;

    const flippedLines: LedgerLine[] = originalEntry.lines.map((l) => ({
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountName: l.accountName,
      debit: l.credit,
      credit: l.debit,
      partyId: l.partyId,
    }));

    this.enforceInvariant(flippedLines);

    const reversedEntry = new this.model({
      workspaceId: firm.workspaceId,
      firmId: firm._id,
      financialYear: debitNote.financialYear,
      entryDate: new Date(),
      entryType: 'debit_note_reversal',
      sourceVoucherId: debitNote._id,
      // Distinct sourceVoucherType → unique-index safe (T-F07W3-06)
      sourceVoucherType: 'debit_note_reversal',
      sourceVoucherNumber: (debitNote.voucherNumber ?? '') + '-REV',
      narration: `Reversal of Debit Note ${debitNote.voucherNumber} (cancelled)`,
      lines: flippedLines,
      isReversed: false,
      postedBy: new Types.ObjectId(userId),
      postedAt: new Date(),
      auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'post_reversal' }],
    });

    await reversedEntry.save({ session });

    // Mark original entry as reversed
    await this.model.updateOne(
      { _id: originalEntry._id },
      {
        $set: {
          isReversed: true,
          reversedBy: new Types.ObjectId(userId),
          reversedAt: new Date(),
        },
      },
      { session },
    );

    return reversedEntry;
  }

  // ─── postManufacturingIssue ───────────────────────────────────────────────

  /**
   * Stage 2 ledger entry: Issue Materials (draft → in_progress).
   *
   * Journal:
   *   Dr  1011 Work In Progress    totalRmCostPaise + totalAdditionalPaise
   *     Cr  1010 Raw Material      totalRmCostPaise
   *     Cr  <additionalCost.accountId>  amountPaise   (one line per overhead entry)
   *
   * All paise values use Math.round to avoid floating-point drift (Pitfall 2).
   * Session is required — caller owns the transaction.
   */
  async postManufacturingIssue(
    mv: ManufacturingVoucherDocument,
    session: ClientSession,
  ): Promise<LedgerEntry> {
    const firm = {
      _id: mv.firmId,
      workspaceId: mv.workspaceId,
    };

    const d = mv.voucherDate;
    const yr = d.getFullYear();
    const mo = d.getMonth() + 1;
    const fyStart = mo >= 4 ? yr : yr - 1;
    const financialYear = `${fyStart}-${String(fyStart + 1).slice(-2)}`;

    const totalRmCostPaise = mv.componentsConsumed.reduce(
      (s, c) => s + Math.round(c.costAtConsumptionPaise * c.qty),
      0,
    );
    const totalAdditionalPaise = mv.additionalCosts.reduce((s, a) => s + a.amountPaise, 0);
    const totalDebitPaise = Math.round(totalRmCostPaise + totalAdditionalPaise);

    const drWip = await this.makeDebitLine(firm, '1011', totalDebitPaise);
    const crRm = await this.makeCreditLine(firm, '1010', totalRmCostPaise);

    // Additional cost accounts are stored as ObjectIds (not codes) — look up by _id
    const additionalCrLines: LedgerLine[] = [];
    for (const ac of mv.additionalCosts) {
      const acc = await this.accountModel
        .findOne({
          _id: ac.accountId,
          workspaceId: mv.workspaceId,
          firmId: mv.firmId,
          isDeleted: false,
        })
        .lean();
      if (!acc) {
        throw new BadRequestException(`Additional cost account ${String(ac.accountId)} not found`);
      }
      additionalCrLines.push({
        accountId: acc._id,
        accountCode: (acc as any).code ?? '',
        accountName: (acc as any).name ?? '',
        debit: 0,
        credit: ac.amountPaise,
      });
    }

    const lines: LedgerLine[] = [drWip, crRm, ...additionalCrLines];
    this.enforceInvariant(lines);

    const entry = new this.model({
      workspaceId: mv.workspaceId,
      firmId: mv.firmId,
      financialYear,
      entryDate: mv.issuedAt ?? new Date(),
      entryType: 'manufacturing_issue',
      sourceVoucherId: mv._id,
      sourceVoucherType: 'manufacturing_voucher',
      sourceVoucherNumber: mv.voucherNumber,
      narration: `Materials issued for ${mv.voucherNumber}`,
      lines,
      isReversed: false,
      postedBy: mv.issuedBy ?? new Types.ObjectId('000000000000000000000000'),
      postedAt: mv.issuedAt ?? new Date(),
      auditLog: [
        {
          at: new Date(),
          by: mv.issuedBy ?? new Types.ObjectId('000000000000000000000000'),
          action: 'post',
        },
      ],
    });

    return entry.save({ session });
  }

  // ─── postManufacturingCompletion ──────────────────────────────────────────

  /**
   * Stage 3 ledger entry: Complete Production (in_progress → completed).
   *
   * Journal (actual cost, no by-products, no variance):
   *   Dr  1012 Finished Goods     fgDebitPaise
   *     Cr  1011 Work In Progress  wipBalancePaise
   *
   * Journal (standard cost, adverse variance):
   *   Dr  1012 Finished Goods     standardFgCostPaise × actualFinishedQty
   *   Dr  5060 Mfg Cost Variance  variancePaise
   *     Cr  1011 Work In Progress  wipBalancePaise
   *
   * Journal (standard cost, favorable variance):
   *   Dr  1012 Finished Goods     standardFgCostPaise × actualFinishedQty
   *     Cr  1011 Work In Progress  wipBalancePaise
   *     Cr  5060 Mfg Cost Variance |variancePaise|
   *
   * By-products (each): Dr 1010 Raw Material (re-enters inventory) / Cr 1011 WIP
   * (the WIP credit already covers by-product NRV via wipBalancePaise total)
   *
   * Session is required — caller owns the transaction.
   */
  async postManufacturingCompletion(
    mv: ManufacturingVoucherDocument,
    session: ClientSession,
  ): Promise<LedgerEntry> {
    // Idempotency guard: if a completion entry already exists (e.g. retry after partial failure),
    // return it rather than attempting a duplicate insert that would hit the unique index.
    const existingCompletion = await this.model
      .findOne({
        workspaceId: mv.workspaceId,
        firmId: mv.firmId,
        sourceVoucherId: mv._id,
        sourceVoucherType: 'manufacturing_voucher_completion',
      })
      .lean();
    if (existingCompletion) return existingCompletion as unknown as LedgerEntry;

    const firm = {
      _id: mv.firmId,
      workspaceId: mv.workspaceId,
    };

    const completionDate = mv.completedAt ?? new Date();
    const yr = completionDate.getFullYear();
    const mo = completionDate.getMonth() + 1;
    const fyStart = mo >= 4 ? yr : yr - 1;
    const financialYear = `${fyStart}-${String(fyStart + 1).slice(-2)}`;

    const wipBalancePaise = mv.totalInputCostPaise;
    const byProductNrvPaise = mv.byProductsProduced.reduce((s, b) => s + b.costAllocatedPaise, 0);

    let fgDebitPaise: number;
    let variancePaise: number;

    if (mv.costMethod === 'standard' && mv.standardFgCostPaise !== undefined) {
      fgDebitPaise = Math.round(mv.standardFgCostPaise * mv.actualFinishedQty);
      variancePaise = Math.round(wipBalancePaise - fgDebitPaise - byProductNrvPaise);
    } else {
      // Actual cost mode: FG absorbs everything not allocated to by-products
      fgDebitPaise = Math.round(wipBalancePaise - byProductNrvPaise);
      variancePaise = 0;
      // Partial completion in actual mode: residual cost goes to variance (D-08)
      if (mv.actualFinishedQty < mv.finishedQty && mv.finishedQty > 0) {
        const completedRatio = mv.actualFinishedQty / mv.finishedQty;
        const completedFg = Math.round(fgDebitPaise * completedRatio);
        variancePaise = Math.round(fgDebitPaise - completedFg);
        fgDebitPaise = completedFg;
      }
    }

    // Persist computed totals back onto mv for downstream use
    mv.variancePaise = variancePaise;
    mv.totalOutputCostPaise = Math.round(fgDebitPaise + byProductNrvPaise);

    const lines: LedgerLine[] = [];

    // Dr Finished Goods (1012)
    if (fgDebitPaise > 0) {
      lines.push(await this.makeDebitLine(firm, '1012', fgDebitPaise));
    }

    // Dr Raw Material (1010) for each by-product re-entering inventory
    for (const bp of mv.byProductsProduced) {
      if (bp.costAllocatedPaise > 0) {
        lines.push(await this.makeDebitLine(firm, '1010', bp.costAllocatedPaise));
      }
    }

    // Dr or Cr Manufacturing Cost Variance (5060) if variance != 0
    if (variancePaise !== 0) {
      const acc5060 = await this.accountsService
        .findByCode(firm.workspaceId.toString(), firm._id.toString(), '5060')
        .catch(() => null);
      if (!acc5060) {
        throw new BadRequestException('Account 5060 missing — run inventory migration to backfill');
      }
      if (variancePaise > 0) {
        // Adverse variance: debit the variance account
        lines.push({
          accountId: acc5060._id as Types.ObjectId,
          accountCode: '5060',
          accountName: acc5060.name,
          debit: variancePaise,
          credit: 0,
        });
      } else {
        // Favorable variance: credit the variance account
        lines.push({
          accountId: acc5060._id as Types.ObjectId,
          accountCode: '5060',
          accountName: acc5060.name,
          debit: 0,
          credit: Math.abs(variancePaise),
        });
      }
    }

    // Cr Work In Progress (1011) — full WIP balance cleared
    lines.push(await this.makeCreditLine(firm, '1011', wipBalancePaise));

    this.enforceInvariant(lines);

    const entry = new this.model({
      workspaceId: mv.workspaceId,
      firmId: mv.firmId,
      financialYear,
      entryDate: completionDate,
      entryType: 'manufacturing_completion',
      sourceVoucherId: mv._id,
      sourceVoucherType: 'manufacturing_voucher_completion',
      sourceVoucherNumber: mv.voucherNumber + '-COMP',
      narration: `Production completed for ${mv.voucherNumber}`,
      lines,
      isReversed: false,
      postedBy: mv.completedBy ?? new Types.ObjectId('000000000000000000000000'),
      postedAt: completionDate,
      auditLog: [
        {
          at: new Date(),
          by: mv.completedBy ?? new Types.ObjectId('000000000000000000000000'),
          action: 'post',
        },
      ],
    });

    return entry.save({ session });
  }

  // ─── postManufacturingReversal ────────────────────────────────────────────

  /**
   * Reversal of the Issue Materials ledger entry when MV is cancelled from in_progress.
   *
   * Flips all Dr ↔ Cr lines from the original issue entry.
   * Uses sourceVoucherType='manufacturing_voucher_reversal' (distinct from original)
   * to satisfy the unique (wsId, firmId, sourceVoucherId, sourceVoucherType) index.
   *
   * Session is required — caller owns the transaction.
   */
  async postManufacturingReversal(
    mv: ManufacturingVoucherDocument,
    originalEntryId: Types.ObjectId,
    session: ClientSession,
  ): Promise<LedgerEntry> {
    // Idempotency guard: if a reversal entry already exists (e.g. retry after partial failure),
    // return it rather than attempting a duplicate insert that would hit the unique index.
    const existingReversal = await this.model
      .findOne({
        workspaceId: mv.workspaceId,
        firmId: mv.firmId,
        sourceVoucherId: mv._id,
        sourceVoucherType: 'manufacturing_voucher_reversal',
      })
      .lean();
    if (existingReversal) return existingReversal as unknown as LedgerEntry;

    const original = await this.model.findById(originalEntryId).lean();
    if (!original) {
      throw new BadRequestException('Original ledger entry not found');
    }

    const cancelDate = mv.cancelledAt ?? new Date();
    const yr = cancelDate.getFullYear();
    const mo = cancelDate.getMonth() + 1;
    const fyStart = mo >= 4 ? yr : yr - 1;
    const financialYear = `${fyStart}-${String(fyStart + 1).slice(-2)}`;

    // Flip Dr ↔ Cr on each line
    const reversedLines: LedgerLine[] = original.lines.map((l: LedgerLine) => ({
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountName: l.accountName,
      debit: l.credit,
      credit: l.debit,
      partyId: l.partyId,
    }));

    this.enforceInvariant(reversedLines);

    const reversal = new this.model({
      workspaceId: mv.workspaceId,
      firmId: mv.firmId,
      financialYear,
      entryDate: cancelDate,
      entryType: 'manufacturing_reversal',
      sourceVoucherId: mv._id,
      sourceVoucherType: 'manufacturing_voucher_reversal',
      sourceVoucherNumber: mv.voucherNumber + '-REV',
      narration: `Cancellation reversal — MV ${mv.voucherNumber}`,
      lines: reversedLines,
      isReversed: false,
      postedBy: mv.cancelledBy ?? new Types.ObjectId('000000000000000000000000'),
      postedAt: cancelDate,
      auditLog: [
        {
          at: new Date(),
          by: mv.cancelledBy ?? new Types.ObjectId('000000000000000000000000'),
          action: 'post_reversal',
        },
      ],
    });

    await reversal.save({ session });

    // Mark original entry as reversed
    await this.model.updateOne(
      { _id: originalEntryId },
      {
        $set: {
          isReversed: true,
          reversedBy: mv.cancelledBy ?? new Types.ObjectId('000000000000000000000000'),
          reversedAt: cancelDate,
        },
      },
      { session },
    );

    return reversal;
  }

  // ─── F-11 Job-Work Invoice posting ────────────────────────────────────────

  /**
   * D-04: Post JW Invoice double-entry.
   *
   * Intrastate (firm state === party placeOfSupplyStateCode):
   *   Dr  1003 Sundry Debtors              totalPaise
   *     Cr  4020 Job-Work Service Income   subTotalPaise
   *     Cr  2007 CGST Payable 2.5%         cgstPaise
   *     Cr  2008 SGST Payable 2.5%         sgstPaise
   *
   * Interstate:
   *   Dr  1003 Sundry Debtors              totalPaise
   *     Cr  4020 Job-Work Service Income   subTotalPaise
   *     Cr  2006 IGST Payable 5%           igstPaise
   *
   * HSN 9988 @ 5% LOCKED (service enforces before calling this method).
   * Invariant: sum(debit) === sum(credit).
   *
   * @param invoice    - The posted JobWorkInvoice document
   * @param isIntrastate - true if firm state code === invoice.placeOfSupplyStateCode
   * @param options    - session, userId, firm (for workspaceId)
   */
  async postJobWorkInvoice(
    invoice: {
      _id: Types.ObjectId;
      workspaceId: Types.ObjectId;
      firmId: Types.ObjectId;
      financialYear: string;
      voucherDate: Date;
      voucherNumber: string;
      partyId: Types.ObjectId;
      narration?: string;
      totalPaise: number;
      subTotalPaise: number;
      cgstPaise?: number;
      sgstPaise?: number;
      igstPaise?: number;
      // D13/§4 + R5: per-line job-work activity + amount, to split income by process
      // (general_textile -> 4020, dyeing_printing -> 4021, printing -> 4022,
      // embroidery -> 4023, other -> 4024; falls back to 4020 when the process ledger
      // isn't seeded, e.g. non-textile firms). Omitted -> the whole subtotal posts to
      // 4020 (back-compat).
      incomeLines?: Array<{ jobWorkType?: string; amountPaise: number }>;
    },
    isIntrastate: boolean,
    options: { session?: ClientSession; userId: string },
  ): Promise<LedgerEntry> {
    const wsId = invoice.workspaceId.toString();
    const firmId = invoice.firmId.toString();

    const lines: LedgerLine[] = [];

    // Dr 1003 Sundry Debtors — full invoice total
    const debtorsAcc = await this.accountsService.findByCode(wsId, firmId, CODE_DEBTORS);
    lines.push({
      accountId: debtorsAcc._id,
      accountCode: CODE_DEBTORS,
      accountName: debtorsAcc.name,
      debit: invoice.totalPaise,
      credit: 0,
      partyId: invoice.partyId,
    });

    // Cr Job-Work Service Income — split by activity (D13/§4) when a line breakdown is
    // provided, else the whole subtotal to 4020. The split always sums to subTotalPaise.
    // R5: process -> textile income ledger. dyeing_printing stays on 4021 (Dyeing) for
    // documents created before the process split; new printing/embroidery rows route to
    // 4022/4023. embroidery is a general 5% process but gets its own income ledger.
    const JW_INCOME_BY_TYPE: Record<string, string> = {
      general_textile: '4020',
      dyeing_printing: '4021',
      printing: '4022',
      embroidery: '4023',
      other: '4024',
    };
    const incomeByCode = new Map<string, number>();
    if (invoice.incomeLines && invoice.incomeLines.length > 0) {
      for (const l of invoice.incomeLines) {
        const preferred = JW_INCOME_BY_TYPE[l.jobWorkType ?? 'general_textile'] ?? '4020';
        // Non-textile firms only have 4020 seeded; fall back when the process ledger is absent.
        const code =
          preferred === '4020' || (await this.accountExists(wsId, firmId, preferred))
            ? preferred
            : '4020';
        incomeByCode.set(code, (incomeByCode.get(code) ?? 0) + l.amountPaise);
      }
    } else {
      incomeByCode.set('4020', invoice.subTotalPaise);
    }
    for (const [code, amountPaise] of incomeByCode) {
      if (amountPaise <= 0) continue;
      const incomeAcc = await this.accountsService.findByCode(wsId, firmId, code);
      lines.push({
        accountId: incomeAcc._id,
        accountCode: code,
        accountName: incomeAcc.name,
        debit: 0,
        credit: amountPaise,
      });
    }

    if (isIntrastate) {
      // Cr 2007 CGST Payable
      if ((invoice.cgstPaise ?? 0) > 0) {
        const cgstAcc = await this.accountsService.findByCode(wsId, firmId, CODE_CGST_PAY);
        lines.push({
          accountId: cgstAcc._id,
          accountCode: CODE_CGST_PAY,
          accountName: cgstAcc.name,
          debit: 0,
          credit: invoice.cgstPaise ?? 0,
        });
      }
      // Cr 2008 SGST Payable
      if ((invoice.sgstPaise ?? 0) > 0) {
        const sgstAcc = await this.accountsService.findByCode(wsId, firmId, CODE_SGST_PAY);
        lines.push({
          accountId: sgstAcc._id,
          accountCode: CODE_SGST_PAY,
          accountName: sgstAcc.name,
          debit: 0,
          credit: invoice.sgstPaise ?? 0,
        });
      }
    } else {
      // Cr 2006 IGST Payable
      if ((invoice.igstPaise ?? 0) > 0) {
        const igstAcc = await this.accountsService.findByCode(wsId, firmId, CODE_IGST_PAY);
        lines.push({
          accountId: igstAcc._id,
          accountCode: CODE_IGST_PAY,
          accountName: igstAcc.name,
          debit: 0,
          credit: invoice.igstPaise ?? 0,
        });
      }
    }

    this.enforceInvariant(lines);

    const entry = new this.model({
      workspaceId: invoice.workspaceId,
      firmId: invoice.firmId,
      financialYear: invoice.financialYear,
      entryDate: invoice.voucherDate,
      entryType: 'job_work_invoice',
      sourceVoucherId: invoice._id,
      sourceVoucherType: 'job_work_invoice',
      sourceVoucherNumber: invoice.voucherNumber,
      narration: invoice.narration ?? `JW Invoice ${invoice.voucherNumber}`,
      lines,
      isReversed: false,
      postedBy: new Types.ObjectId(options.userId),
      postedAt: new Date(),
      auditLog: [],
    });

    return entry.save({ session: options.session });
  }

  /**
   * D-04 cancel path: post mirrored LedgerEntry with entryType 'job_work_invoice_reverse'.
   * Debits become credits and vice versa. Original entry is NOT deleted — full audit trail.
   * Uses sourceVoucherType='job_work_invoice_reverse' to satisfy the unique
   * (workspaceId, firmId, sourceVoucherId, sourceVoucherType) index on LedgerEntry.
   */
  async reverseJobWorkInvoice(
    originalEntry: LedgerEntry,
    invoice: {
      _id: Types.ObjectId;
      voucherNumber: string;
    },
    options: { session?: ClientSession; userId: string },
  ): Promise<LedgerEntry> {
    const reversedLines: LedgerLine[] = originalEntry.lines.map((l) => ({
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountName: l.accountName,
      debit: l.credit,
      credit: l.debit,
      partyId: l.partyId,
    }));

    this.enforceInvariant(reversedLines);

    const reversal = new this.model({
      workspaceId: originalEntry.workspaceId,
      firmId: originalEntry.firmId,
      financialYear: originalEntry.financialYear,
      entryDate: new Date(),
      entryType: 'job_work_invoice_reverse',
      sourceVoucherId: invoice._id,
      // Distinct sourceVoucherType avoids unique-index collision with original entry
      sourceVoucherType: 'job_work_invoice_reverse',
      sourceVoucherNumber: invoice.voucherNumber + '-REV',
      narration: `Reversal of ${invoice.voucherNumber}`,
      lines: reversedLines,
      isReversed: false,
      postedBy: new Types.ObjectId(options.userId),
      postedAt: new Date(),
      auditLog: [],
    });

    const saved = await reversal.save({ session: options.session });

    // Mark original entry as reversed
    await this.model.updateOne(
      { _id: originalEntry._id },
      {
        $set: {
          isReversed: true,
          reversedBy: saved._id,
          reversedAt: new Date(),
        },
      },
      { session: options.session },
    );

    return saved;
  }

  // ─── postOpeningBalance ───────────────────────────────────────────────────

  /**
   * Set (or replace) a ledger's opening balance as a posted 'opening_balance'
   * LedgerEntry, so it flows into the trial balance / account ledger / balance
   * sheet automatically (those reports aggregate LedgerEntry rows before the
   * period). The balancing contra is 3004 Opening Balance Equity, so the opening
   * books still net to zero across all accounts.
   *
   * One entry per account (unique on sourceVoucherId=account._id +
   * sourceVoucherType='opening_balance'): a re-set UPDATES the same row in place
   * (a reverse-and-repost would collide with that unique index); amountPaise<=0
   * removes it. drOrCr is the side of the ACCOUNT line (debit for asset/expense
   * opening debit balances, credit for liability/capital/income); equity takes the
   * opposite side. Invariant enforced.
   */
  async postOpeningBalance(
    account: { _id: Types.ObjectId; code: string; name: string },
    params: {
      workspaceId: Types.ObjectId;
      firmId: Types.ObjectId;
      amountPaise: number;
      drOrCr: 'debit' | 'credit';
      asOfDate: Date;
      financialYear: string;
    },
    opts: { session?: ClientSession; userId: string },
  ): Promise<LedgerEntry | null> {
    const CODE_OPENING_BALANCE_EQUITY = '3004';

    const existing = await this.model
      .findOne({
        workspaceId: params.workspaceId,
        firmId: params.firmId,
        sourceVoucherId: account._id,
        sourceVoucherType: 'opening_balance',
      })
      .session(opts.session ?? null);

    // Clearing the opening balance: do NOT hard-delete a posted ledger entry (immutability +
    // audit). Mark it reversed so it drops out of balance reports (which filter isReversed:false)
    // while the row + trail survive; a later set reactivates it via the in-place update below.
    if (params.amountPaise <= 0) {
      if (existing) {
        existing.isReversed = true;
        (existing as unknown as { reversedAt?: Date }).reversedAt = new Date();
        existing.auditLog = [
          ...(existing.auditLog ?? []),
          { at: new Date(), by: new Types.ObjectId(opts.userId), action: 'reverse' } as never,
        ];
        await existing.save({ session: opts.session });
      }
      return null;
    }

    const equityAcc = await this.accountsService.findByCode(
      params.workspaceId.toString(),
      params.firmId.toString(),
      CODE_OPENING_BALANCE_EQUITY,
    );

    const lines: LedgerLine[] = [
      {
        accountId: account._id,
        accountCode: account.code,
        accountName: account.name,
        debit: params.drOrCr === 'debit' ? params.amountPaise : 0,
        credit: params.drOrCr === 'credit' ? params.amountPaise : 0,
      },
      {
        accountId: equityAcc._id,
        accountCode: CODE_OPENING_BALANCE_EQUITY,
        accountName: equityAcc.name,
        debit: params.drOrCr === 'credit' ? params.amountPaise : 0,
        credit: params.drOrCr === 'debit' ? params.amountPaise : 0,
      },
    ];
    this.enforceInvariant(lines);

    const narration = `Opening balance for ${account.name}`;

    // Update the existing entry in place (unique-index safe) or create the first one.
    if (existing) {
      existing.entryDate = params.asOfDate;
      existing.financialYear = params.financialYear;
      existing.lines = lines;
      existing.narration = narration;
      existing.isReversed = false;
      existing.postedBy = new Types.ObjectId(opts.userId);
      existing.postedAt = new Date();
      // R15: the re-set path mutates an authoritative ledger entry (re-activating a
      // cleared one or revaluing it), so it must append to the trail like the clear
      // ('reverse') and create ('post') branches do - it was silently overwriting
      // without leaving a record of the change.
      existing.auditLog = [
        ...(existing.auditLog ?? []),
        { at: new Date(), by: new Types.ObjectId(opts.userId), action: 'post' } as never,
      ];
      return existing.save({ session: opts.session });
    }

    const entry = new this.model({
      workspaceId: params.workspaceId,
      firmId: params.firmId,
      financialYear: params.financialYear,
      entryDate: params.asOfDate,
      entryType: 'opening_balance',
      sourceVoucherId: account._id,
      sourceVoucherType: 'opening_balance',
      sourceVoucherNumber: `OB-${account.code}`,
      narration,
      lines,
      isReversed: false,
      postedBy: new Types.ObjectId(opts.userId),
      postedAt: new Date(),
      auditLog: [{ at: new Date(), by: new Types.ObjectId(opts.userId), action: 'post' }],
    });
    return entry.save({ session: opts.session });
  }
}
