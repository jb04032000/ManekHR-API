import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ReconciliationSession } from './reconciliation-session.schema';
import { BankStatement } from './bank-statement.schema';
import { BankStatementRow } from './bank-statement-row.schema';
import { LedgerEntry } from '../sales/ledger-posting/ledger-entry.schema';
import { BankAccount } from '../bank-accounts/bank-account.schema';

// ─── BRS Report Shape (ICAI Format) ─────────────────────────────────────────

export interface BrsReport {
  sessionId: string;
  bankAccountName: string;
  /** Last 4 digits only; rest masked as bullet characters */
  bankAccountNumberMasked: string;
  periodFrom: string;
  periodTo: string;
  financialYear: string;

  // ── Statement-side balance ──────────────────────────────────────────────
  statementClosingBalancePaise: number;

  // ── ADD section: items to add to statement balance to reconcile ─────────
  addItems: Array<{ label: string; amountPaise: number; rowIds: string[] }>;
  addSubtotalPaise: number;

  // ── LESS section: items to deduct from statement balance ────────────────
  lessItems: Array<{ label: string; amountPaise: number; rowIds: string[] }>;
  lessSubtotalPaise: number;

  // ── Computed and actual ledger balances ─────────────────────────────────
  /** statementClosingBalance + addSubtotal - lessSubtotal */
  computedCashBookBalancePaise: number;
  /** Actual ledger balance: sum(lines.debit - lines.credit) for bank CoA code */
  ledgerCashBookBalancePaise: number;
  /** computedCashBook - ledgerCashBook; 0 when fully reconciled */
  differencePaise: number;
  isFullyReconciled: boolean;

  // ── Itemised detail arrays ───────────────────────────────────────────────
  outstandingCheques: Array<{
    voucherNumber: string;
    entryDate: string;
    amountPaise: number;
  }>;
  depositsInTransit: Array<{
    voucherNumber: string;
    entryDate: string;
    amountPaise: number;
  }>;
  bankChargesNotInBooks: Array<{
    rowId: string;
    txnDate: string;
    narration: string;
    amountPaise: number;
  }>;
}

// ─── BrsReportService ────────────────────────────────────────────────────────

@Injectable()
export class BrsReportService {
  constructor(
    @InjectModel(ReconciliationSession.name)
    private readonly sessionModel: Model<ReconciliationSession>,
    @InjectModel(BankStatement.name)
    private readonly statementModel: Model<BankStatement>,
    @InjectModel(BankStatementRow.name)
    private readonly rowModel: Model<BankStatementRow>,
    @InjectModel(LedgerEntry.name)
    private readonly ledgerModel: Model<LedgerEntry>,
    @InjectModel(BankAccount.name)
    private readonly bankAccountModel: Model<BankAccount>,
  ) {}

  /**
   * Generates an ICAI-format Bank Reconciliation Statement for a session.
   *
   * ICAI BRS format (Indian):
   *   Balance as per bank statement (closing)
   *   ADD:  Cheques issued but not presented to bank (outstanding payments)
   *         Deposits credited by bank but not yet in books
   *   LESS: Cheques deposited but not yet cleared by bank (deposits in transit)
   *         Bank charges / TDS debited by bank but not in books
   *         Other direct debits not yet recorded
   *   = Balance as per cash book / ledger
   */
  async generate(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    sessionId: Types.ObjectId,
  ): Promise<BrsReport> {
    // ── 1. Load session with scope check ──────────────────────────────────
    const session = await this.sessionModel
      .findOne({ _id: sessionId, workspaceId: wsId, firmId })
      .lean<ReconciliationSession & { _id: Types.ObjectId }>();
    if (!session) throw new NotFoundException('Reconciliation session not found');

    // ── 2. Load statement + bank account ─────────────────────────────────
    const statement = await this.statementModel
      .findOne({ _id: session.bankStatementId, workspaceId: wsId, firmId })
      .lean<BankStatement & { _id: Types.ObjectId }>();
    if (!statement) throw new NotFoundException('Bank statement not found');

    const bankAccount = await this.bankAccountModel
      .findOne({ _id: session.bankAccountId, workspaceId: wsId, firmId, isDeleted: false })
      .lean<BankAccount & { _id: Types.ObjectId }>();
    if (!bankAccount) throw new NotFoundException('Bank account not found');

    const periodTo = session.periodTo;
    const coaCode = bankAccount.coaAccountCode;

    // ── 3. Build ADD items ────────────────────────────────────────────────

    // ADD (a): Cheques issued but NOT yet presented to bank
    //   = payment_out LedgerEntries that credit the bank account, uncleared, dated <= periodTo
    const outstandingPayments = await this.ledgerModel
      .find({
        workspaceId: wsId,
        firmId,
        entryType: 'payment_out',
        entryDate: { $lte: periodTo },
        clearedInReconciliation: false,
        'lines.accountCode': coaCode,
        'lines.credit': { $gt: 0 },
      })
      .lean<Array<LedgerEntry & { _id: Types.ObjectId }>>();

    // Filter to only entries that have a credit line for this bank account
    const outstandingChequesEntries = outstandingPayments.filter((e) =>
      e.lines.some((l) => l.accountCode === coaCode && l.credit > 0),
    );

    const outstandingChequesAmount = outstandingChequesEntries.reduce((sum, e) => {
      const bankLine = e.lines.find((l) => l.accountCode === coaCode && l.credit > 0);
      return sum + (bankLine ? bankLine.credit : 0);
    }, 0);

    // ADD (b): Deposits credited by bank but not yet in books
    //   = Unmatched credit rows (amountPaise > 0) in this statement
    const unmatchedCreditRows = await this.rowModel
      .find({
        bankStatementId: statement._id,
        workspaceId: wsId,
        firmId,
        status: 'unmatched',
        amountPaise: { $gt: 0 },
      })
      .lean<Array<BankStatementRow & { _id: Types.ObjectId }>>();

    const unmatchedCreditAmount = unmatchedCreditRows.reduce((s, r) => s + r.amountPaise, 0);

    const addItems: BrsReport['addItems'] = [];
    if (outstandingChequesAmount > 0) {
      addItems.push({
        label: 'Cheques issued but not yet presented to bank',
        amountPaise: outstandingChequesAmount,
        rowIds: outstandingChequesEntries.map((e) => String(e._id)),
      });
    }
    if (unmatchedCreditAmount > 0) {
      addItems.push({
        label: 'Deposits credited by bank not yet recorded in books',
        amountPaise: unmatchedCreditAmount,
        rowIds: unmatchedCreditRows.map((r) => String(r._id)),
      });
    }
    const addSubtotalPaise = addItems.reduce((s, i) => s + i.amountPaise, 0);

    // ── 4. Build LESS items ───────────────────────────────────────────────

    // LESS (a): Cheques deposited but not yet cleared
    //   = payment_in LedgerEntries that debit the bank account, uncleared, dated <= periodTo
    const depositsInTransitEntries = await this.ledgerModel
      .find({
        workspaceId: wsId,
        firmId,
        entryType: 'payment_in',
        entryDate: { $lte: periodTo },
        clearedInReconciliation: false,
        'lines.accountCode': coaCode,
        'lines.debit': { $gt: 0 },
      })
      .lean<Array<LedgerEntry & { _id: Types.ObjectId }>>();

    // Filter to entries with a debit line for this bank account
    const filteredDeposits = depositsInTransitEntries.filter((e) =>
      e.lines.some((l) => l.accountCode === coaCode && l.debit > 0),
    );

    const depositsInTransitAmount = filteredDeposits.reduce((sum, e) => {
      const bankLine = e.lines.find((l) => l.accountCode === coaCode && l.debit > 0);
      return sum + (bankLine ? bankLine.debit : 0);
    }, 0);

    // LESS (b) + (c): Unmatched debit rows in the statement
    //   = bank charges / interest / TDS debits not yet in books
    const unmatchedDebitRows = await this.rowModel
      .find({
        bankStatementId: statement._id,
        workspaceId: wsId,
        firmId,
        status: 'unmatched',
        amountPaise: { $lt: 0 },
      })
      .lean<Array<BankStatementRow & { _id: Types.ObjectId }>>();

    // Partition: bank charge patterns vs other direct debits
    const chargePatterns = /bank.?charg|service.?fee|sms.?charg|annual.?fee|proc.?fee|tds|gst.?on|interest.?paid|debit.?card/i;
    const bankChargeRows = unmatchedDebitRows.filter((r) =>
      chargePatterns.test(r.narration || r.narrationNorm || ''),
    );
    const otherDebitRows = unmatchedDebitRows.filter(
      (r) => !chargePatterns.test(r.narration || r.narrationNorm || ''),
    );

    const bankChargesAmount = bankChargeRows.reduce((s, r) => s + Math.abs(r.amountPaise), 0);
    const otherDebitsAmount = otherDebitRows.reduce((s, r) => s + Math.abs(r.amountPaise), 0);

    const lessItems: BrsReport['lessItems'] = [];
    if (depositsInTransitAmount > 0) {
      lessItems.push({
        label: 'Cheques deposited but not yet cleared by bank',
        amountPaise: depositsInTransitAmount,
        rowIds: filteredDeposits.map((e) => String(e._id)),
      });
    }
    if (bankChargesAmount > 0) {
      lessItems.push({
        label: 'Bank charges / interest / TDS not yet recorded in books',
        amountPaise: bankChargesAmount,
        rowIds: bankChargeRows.map((r) => String(r._id)),
      });
    }
    if (otherDebitsAmount > 0) {
      lessItems.push({
        label: 'Direct debits by bank not yet recorded in books',
        amountPaise: otherDebitsAmount,
        rowIds: otherDebitRows.map((r) => String(r._id)),
      });
    }
    const lessSubtotalPaise = lessItems.reduce((s, i) => s + i.amountPaise, 0);

    // ── 5. Compute balances ───────────────────────────────────────────────
    const statementClosingBalancePaise = statement.closingBalancePaise;
    const computedCashBookBalancePaise =
      statementClosingBalancePaise + addSubtotalPaise - lessSubtotalPaise;

    // ── 6. Ledger cash book balance ───────────────────────────────────────
    //   sum(lines.debit - lines.credit) for bank CoA code up to periodTo
    const ledgerAgg = await this.ledgerModel.aggregate([
      {
        $match: {
          workspaceId: wsId,
          firmId,
          'lines.accountCode': coaCode,
          entryDate: { $lte: periodTo },
        },
      },
      { $unwind: '$lines' },
      { $match: { 'lines.accountCode': coaCode } },
      {
        $group: {
          _id: null,
          totalDebit: { $sum: '$lines.debit' },
          totalCredit: { $sum: '$lines.credit' },
        },
      },
    ]);
    const ledgerCashBookBalancePaise =
      ledgerAgg.length > 0 ? ledgerAgg[0].totalDebit - ledgerAgg[0].totalCredit : 0;

    // ── 7. Difference and reconciliation status ───────────────────────────
    const differencePaise = computedCashBookBalancePaise - ledgerCashBookBalancePaise;
    const isFullyReconciled = differencePaise === 0;

    // ── 8. Fill itemised detail arrays ────────────────────────────────────

    // Outstanding cheques detail
    const outstandingCheques: BrsReport['outstandingCheques'] = outstandingChequesEntries.map(
      (e) => {
        const bankLine = e.lines.find((l) => l.accountCode === coaCode && l.credit > 0);
        return {
          voucherNumber: e.sourceVoucherNumber,
          entryDate: e.entryDate.toISOString().slice(0, 10),
          amountPaise: bankLine ? bankLine.credit : 0,
        };
      },
    );

    // Deposits in transit detail
    const depositsInTransit: BrsReport['depositsInTransit'] = filteredDeposits.map((e) => {
      const bankLine = e.lines.find((l) => l.accountCode === coaCode && l.debit > 0);
      return {
        voucherNumber: e.sourceVoucherNumber,
        entryDate: e.entryDate.toISOString().slice(0, 10),
        amountPaise: bankLine ? bankLine.debit : 0,
      };
    });

    // Bank charges detail
    const bankChargesNotInBooks: BrsReport['bankChargesNotInBooks'] = bankChargeRows.map((r) => ({
      rowId: String(r._id),
      txnDate: r.txnDate.toISOString().slice(0, 10),
      narration: r.narration,
      amountPaise: Math.abs(r.amountPaise),
    }));

    // ── 9. Mask account number ────────────────────────────────────────────
    const rawAccNum = bankAccount.accountNumber ?? '';
    const bankAccountNumberMasked =
      rawAccNum.length > 4
        ? '•'.repeat(rawAccNum.length - 4) + rawAccNum.slice(-4)
        : rawAccNum;

    return {
      sessionId: String(sessionId),
      bankAccountName: bankAccount.name,
      bankAccountNumberMasked,
      periodFrom: session.periodFrom.toISOString().slice(0, 10),
      periodTo: session.periodTo.toISOString().slice(0, 10),
      financialYear: session.financialYear,
      statementClosingBalancePaise,
      addItems,
      addSubtotalPaise,
      lessItems,
      lessSubtotalPaise,
      computedCashBookBalancePaise,
      ledgerCashBookBalancePaise,
      differencePaise,
      isFullyReconciled,
      outstandingCheques,
      depositsInTransit,
      bankChargesNotInBooks,
    };
  }
}
