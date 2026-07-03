import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { FirmsService } from '../finance/firms/firms.service';
import { AccountsService } from '../finance/ledger/accounts.service';

// ─── COA constants ────────────────────────────────────────────────────────────
const CODE_SALARY_EXPENSE = '5003'; // Salary Expense (expense) — already seeded
// BUGFIX (account-code collision): Salary Advance was originally coded '1013',
// but '1013' is already "Work In Progress - Services" in the service-firm CoA
// template (seeds/index.ts serviceSeeds), and was never seeded into the
// trading/manufacturing/composition/textile templates at all. So advance posting
// either threw "account 1013 not found" (non-service firms) or mis-posted to the
// WIP asset (service firms). Re-coded to the free '1014' which is now seeded into
// commonComplianceSeeds (every template) + backfilled to existing firms by
// migration 0038. The old empty '1013' Salary Advance rows (from migration 0009)
// are left untouched (non-destructive); going forward all advances use '1014'.
const CODE_SALARY_ADVANCE = '1014'; // Salary Advance (asset) — see note above
const CODE_CASH = '1001'; // Cash (asset)             — default credit account

// ─── Posting result ───────────────────────────────────────────────────────────
export interface LedgerPostResult {
  posted: boolean;
  reason?: string;
}

/**
 * SalaryLedgerPostingService
 *
 * Finance bridge for D-06/D-07.
 *
 * Resolves the workspace's Finance firm (oldest = main, RESEARCH A2), then
 * posts balanced double-entry LedgerEntries for salary and advance payments.
 * If no firm exists the posting is silently skipped (D-07) — salary payment
 * is NEVER blocked by Finance setup.
 *
 * Idempotent: the unique index on (wsId, firmId, sourceVoucherId,
 * sourceVoucherType) swallows E11000 on re-post (RESEARCH Pitfall 2).
 */
@Injectable()
export class SalaryLedgerPostingService {
  private readonly logger = new Logger(SalaryLedgerPostingService.name);

  constructor(
    @InjectModel('LedgerEntry')
    private readonly ledgerEntryModel: Model<any>,
    private readonly firmsService: FirmsService,
    private readonly accountsService: AccountsService,
  ) {}

  // ─── Financial year helper ──────────────────────────────────────────────────

  /**
   * Compute Indian FY string from a date.
   * FY starts 1 April; e.g., 2025-06-15 → '2025-2026'.
   */
  private fyForDate(d: Date): string {
    const m = d.getUTCMonth() + 1; // 1–12
    const y = d.getUTCFullYear();
    return m >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
  }

  // ─── Firm resolution (D-07) ────────────────────────────────────────────────

  /**
   * Resolve the main Finance firm for the workspace.
   * Returns null when no firm exists (silent skip per D-07).
   * Logs a warning when multiple firms exist; uses the oldest (last in DESC sort).
   */
  private async resolveFirm(workspaceId: string) {
    const firms = await this.firmsService.findAll(workspaceId);
    if (!firms.length) {
      this.logger.warn(`No Finance firm for ws ${workspaceId}; skipping salary ledger posting`);
      return null;
    }
    if (firms.length > 1) {
      this.logger.warn(`Multi-firm ws ${workspaceId}; using oldest firm for salary ledger posting`);
    }
    // findAll sorts createdAt DESC → last element = oldest = main firm (RESEARCH A2)
    return firms[firms.length - 1];
  }

  /**
   * Public accessor so salary.service.ts can obtain the firmId for the COA
   * picker endpoint without re-implementing the resolution logic.
   */
  async resolveFirmId(workspaceId: string): Promise<string | null> {
    const firm = await this.resolveFirm(workspaceId);
    return firm ? String(firm._id) : null;
  }

  /**
   * D-10 COA picker: returns cash/bank accounts for the workspace's firm.
   * Filters to type=asset AND (code 1001/1002 OR subGroup 'Cash & Bank').
   * Returns [] when no firm is configured (D-07 — caller shows financeConfigured:false).
   */
  async findCashBankAccounts(
    workspaceId: string,
  ): Promise<{ accountId: string; code: string; name: string }[]> {
    const firmId = await this.resolveFirmId(workspaceId);
    if (!firmId) return [];

    const allAccounts = await this.accountsService.findAll(workspaceId, firmId);
    return allAccounts
      .filter(
        (a: any) =>
          a.type === 'asset' &&
          (a.code === '1001' || a.code === '1002' || a.subGroup === 'Cash & Bank'),
      )
      .map((a: any) => ({
        accountId: String(a._id),
        code: a.code,
        name: a.name,
      }));
  }

  // ─── Credit account resolution ─────────────────────────────────────────────

  /**
   * Resolve the credit (cash/bank) account for a payment posting.
   * If coaAccountId is provided, validate it belongs to the firm and is asset
   * or liability type (INVALID_COA_ACCOUNT otherwise).
   * Falls back to CODE_CASH (1001) when no coaAccountId supplied.
   */
  private async resolveCreditAccount(wsId: string, firmId: string, coaAccountId?: string) {
    if (coaAccountId) {
      const accounts = await this.accountsService.findAll(wsId, firmId);
      const found = accounts.find((a) => String(a._id) === coaAccountId);
      if (!found) {
        throw new BadRequestException('INVALID_COA_ACCOUNT');
      }
      if (found.type !== 'asset' && found.type !== 'liability') {
        throw new BadRequestException('INVALID_COA_ACCOUNT');
      }
      return found;
    }
    return this.accountsService.findByCode(wsId, firmId, CODE_CASH);
  }

  // ─── Salary payment posting (D-06) ─────────────────────────────────────────

  /**
   * Post a balanced double-entry journal for a salary payment:
   *   Dr  5003 Salary Expense        netSalaryPaise
   *     Cr  [coaAccountId / 1001]    netSalaryPaise
   *
   * Returns { posted: false, reason } when no firm exists (D-07 silent skip).
   * Returns { posted: true } on success or idempotent re-post (E11000).
   */
  async postSalaryPayment(
    payment: any,
    salary: any,
    coaAccountId: string | undefined,
    userId: string,
  ): Promise<LedgerPostResult> {
    const wsId = String(payment.workspaceId);
    const firm = await this.resolveFirm(wsId);
    if (!firm) {
      return { posted: false, reason: 'no_firm' };
    }

    const firmId = String(firm._id);
    // BUGFIX (paise unit mismatch): salary `payment.amount` is stored in RUPEES
    // (the salary module's convention — see statistics.service totalPaid sum and
    // CashLedgerEntry), but the finance LedgerEntry stores money in PAISE
    // (see ledger-entry.schema "Amount in paise"). Previously this assigned the
    // rupee value straight into a field named `amountPaise`, so ₹30,000 was
    // posted as 30000 paise and displayed as ₹300 (100× too small). Convert here.
    const amountPaise: number = Math.round(payment.amount * 100);

    const [debitAcc, creditAcc] = await Promise.all([
      this.accountsService.findByCode(wsId, firmId, CODE_SALARY_EXPENSE),
      this.resolveCreditAccount(wsId, firmId, coaAccountId),
    ]);

    const lines = [
      {
        accountId: new Types.ObjectId(String(debitAcc._id)),
        accountCode: CODE_SALARY_EXPENSE,
        accountName: debitAcc.name,
        debit: amountPaise,
        credit: 0,
      },
      {
        accountId: new Types.ObjectId(String(creditAcc._id)),
        accountCode: creditAcc.code,
        accountName: creditAcc.name,
        debit: 0,
        credit: amountPaise,
      },
    ];

    // Invariant: balanced double-entry (T-26-15)
    const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
    const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
    if (totalDebit !== totalCredit) {
      throw new InternalServerErrorException(
        `Salary ledger lines unbalanced: Dr ${totalDebit} Cr ${totalCredit}`,
      );
    }

    const paymentDate: Date = payment.paymentDate ?? new Date();

    try {
      await this.ledgerEntryModel.create({
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        financialYear: this.fyForDate(paymentDate),
        entryDate: paymentDate,
        entryType: 'salary_payment',
        sourceVoucherId: new Types.ObjectId(String(payment._id)),
        sourceVoucherType: 'salary_payment',
        sourceVoucherNumber: `SAL-${salary.month}/${salary.year}`,
        narration: '',
        lines,
        postedBy: new Types.ObjectId(userId),
        postedAt: new Date(),
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        // Idempotent: same payment already posted (Pitfall 2)
        this.logger.log(`Salary payment ${String(payment._id)} already posted (E11000 swallowed)`);
        return { posted: true };
      }
      throw err;
    }

    return { posted: true };
  }

  // ─── Advance payment posting (D-06) ────────────────────────────────────────

  /**
   * Post a balanced double-entry journal for an advance salary payment:
   *   Dr  1014 Salary Advance        advancePaise
   *     Cr  [coaAccountId / 1001]    advancePaise
   *
   * Returns { posted: false, reason } when no firm exists (D-07 silent skip).
   * Returns { posted: true } on success or idempotent re-post (E11000).
   */
  async postAdvancePayment(
    payment: any,
    advanceRequest: any,
    coaAccountId: string | undefined,
    userId: string,
  ): Promise<LedgerPostResult> {
    const wsId = String(payment.workspaceId);
    const firm = await this.resolveFirm(wsId);
    if (!firm) {
      return { posted: false, reason: 'no_firm' };
    }

    const firmId = String(firm._id);
    // BUGFIX (paise unit mismatch): same rupees→paise conversion as
    // postSalaryPayment. `payment.amount` is rupees; LedgerEntry stores paise.
    const amountPaise: number = Math.round(payment.amount * 100);

    const [debitAcc, creditAcc] = await Promise.all([
      this.accountsService.findByCode(wsId, firmId, CODE_SALARY_ADVANCE),
      this.resolveCreditAccount(wsId, firmId, coaAccountId),
    ]);

    const lines = [
      {
        accountId: new Types.ObjectId(String(debitAcc._id)),
        accountCode: CODE_SALARY_ADVANCE,
        accountName: debitAcc.name,
        debit: amountPaise,
        credit: 0,
      },
      {
        accountId: new Types.ObjectId(String(creditAcc._id)),
        accountCode: creditAcc.code,
        accountName: creditAcc.name,
        debit: 0,
        credit: amountPaise,
      },
    ];

    // Invariant: balanced double-entry (T-26-15)
    const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
    const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
    if (totalDebit !== totalCredit) {
      throw new InternalServerErrorException(
        `Advance ledger lines unbalanced: Dr ${totalDebit} Cr ${totalCredit}`,
      );
    }

    const paymentDate: Date = payment.paymentDate ?? new Date();

    try {
      await this.ledgerEntryModel.create({
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        financialYear: this.fyForDate(paymentDate),
        entryDate: paymentDate,
        entryType: 'salary_advance',
        sourceVoucherId: new Types.ObjectId(String(payment._id)),
        sourceVoucherType: 'salary_advance',
        sourceVoucherNumber: `ADV-${advanceRequest.month}/${advanceRequest.year}`,
        narration: '',
        lines,
        postedBy: new Types.ObjectId(userId),
        postedAt: new Date(),
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        // Idempotent: same advance payment already posted (Pitfall 2)
        this.logger.log(`Advance payment ${String(payment._id)} already posted (E11000 swallowed)`);
        return { posted: true };
      }
      throw err;
    }

    return { posted: true };
  }

  // ─── Reversal posting ───────────────────────────────────────────────────────

  /**
   * Post a compensating (reversal) journal when a salary/advance Payment is
   * reversed, so the finance books don't keep overstating salary expense / cash
   * outflow after a reversal. Reads the ORIGINAL posted LedgerEntry (by
   * sourceVoucherId = payment._id) and mirrors it with debit/credit swapped under
   * a *_reversal entryType. Works for whatever cash/bank account the original used
   * (no COA code lookup needed) and for the exact original amount.
   *
   * Idempotent via the unique (ws,firm,sourceVoucherId,sourceVoucherType) index —
   * the reversal uses a DISTINCT sourceVoucherType, so it neither collides with
   * the original nor double-posts. Returns { posted:false } when no firm exists
   * or the original was never posted (e.g. it skipped at pay time).
   */
  private async postReversal(
    payment: any,
    originalType: 'salary_payment' | 'salary_advance',
    reversalType: 'salary_payment_reversal' | 'salary_advance_reversal',
    voucherPrefix: string,
    userId: string,
  ): Promise<LedgerPostResult> {
    const wsId = String(payment.workspaceId);
    const firm = await this.resolveFirm(wsId);
    if (!firm) {
      return { posted: false, reason: 'no_firm' };
    }
    const firmId = String(firm._id);

    const original: any = await this.ledgerEntryModel
      .findOne({
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        sourceVoucherId: new Types.ObjectId(String(payment._id)),
        sourceVoucherType: originalType,
      })
      .lean()
      .exec();

    if (!original) {
      // Original was never posted (e.g. no firm at pay time) → nothing to reverse.
      return { posted: false, reason: 'no_original' };
    }

    // Mirror each line with debit/credit swapped (keeps it balanced by construction).
    const lines = (original.lines as any[]).map((l) => ({
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountName: l.accountName,
      debit: l.credit,
      credit: l.debit,
    }));

    const reversalDate = new Date();
    try {
      await this.ledgerEntryModel.create({
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        financialYear: this.fyForDate(reversalDate),
        entryDate: reversalDate,
        entryType: reversalType,
        sourceVoucherId: new Types.ObjectId(String(payment._id)),
        sourceVoucherType: reversalType,
        sourceVoucherNumber: `${voucherPrefix}-${String(original.sourceVoucherNumber ?? '')}`,
        narration: 'Reversal of reversed salary payment',
        lines,
        postedBy: new Types.ObjectId(userId),
        postedAt: new Date(),
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        // Idempotent: reversal already posted for this payment.
        this.logger.log(
          `Reversal for payment ${String(payment._id)} already posted (E11000 swallowed)`,
        );
        return { posted: true };
      }
      throw err;
    }

    // Flag the original so the trial balance / drill-downs show it as reversed.
    await this.ledgerEntryModel
      .updateOne(
        { _id: original._id },
        {
          $set: {
            isReversed: true,
            reversedBy: new Types.ObjectId(userId),
            reversedAt: reversalDate,
          },
        },
      )
      .exec();

    return { posted: true };
  }

  /** Reverse a salary-payment journal (mirrors Dr 5003 / Cr cash → Dr cash / Cr 5003). */
  async postSalaryReversal(payment: any, userId: string): Promise<LedgerPostResult> {
    return this.postReversal(
      payment,
      'salary_payment',
      'salary_payment_reversal',
      'SAL-REV',
      userId,
    );
  }

  /** Reverse an advance-payment journal (mirrors Dr 1014 / Cr cash → Dr cash / Cr 1014). */
  async postAdvanceReversal(payment: any, userId: string): Promise<LedgerPostResult> {
    return this.postReversal(
      payment,
      'salary_advance',
      'salary_advance_reversal',
      'ADV-REV',
      userId,
    );
  }
}
