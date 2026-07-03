import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types, ClientSession } from 'mongoose';
import { withFinanceSpan } from '../common/finance-observability';
import { BankAccount } from './bank-account.schema';
import { LedgerEntry } from '../sales/ledger-posting/ledger-entry.schema';
import { CreateBankAccountDto } from './dto/create-bank-account.dto';
import { UpdateBankAccountDto } from './dto/update-bank-account.dto';
import { ListBankAccountsDto } from './dto/list-bank-accounts.dto';
import { GetStatementDto } from './dto/get-statement.dto';

/**
 * BankAccountsService — manages firm-scoped bank accounts.
 *
 * Key responsibilities:
 *  - CRUD for BankAccount documents (name, bankName, accountType, CoA linkage)
 *  - Account number masking on response: last-4 digits only (T-F06W1-03)
 *  - Default account enforcement: only one default per firm
 *  - Opening balance → currentBalancePaise initialisation
 *  - atomicCredit / atomicDebit — called by ChequeService and LoanService on settlement
 *
 * All methods scope by both workspaceId AND firmId — no cross-firm data leakage.
 */
@Injectable()
export class BankAccountsService {
  // Platform-bar observability: shared finance tracer. These write methods carry no
  // userId in their signatures, so they get a span only (no PostHog event per the rule).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(BankAccount.name)
    private readonly model: Model<BankAccount>,
    @InjectModel(LedgerEntry.name)
    private readonly ledgerEntryModel: Model<LedgerEntry>,
  ) {}

  // ─── Masking helper ───────────────────────────────────────────────────────

  /**
   * Returns the account number with all but the last 4 digits replaced by '*'.
   * T-F06W1-03: Masking is response-layer responsibility; stored as plain string.
   *
   * Examples:
   *   "12345678901234" → "**********1234"
   *   "1234"           → "1234"
   *   undefined        → undefined
   */
  private maskAccountNumber(raw?: string): string | undefined {
    if (!raw) return undefined;
    if (raw.length <= 4) return raw;
    return '*'.repeat(raw.length - 4) + raw.slice(-4);
  }

  private applyMask(account: BankAccount): BankAccount {
    const obj = account.toObject ? account.toObject() : { ...account };
    if (obj.accountNumber) {
      obj.accountNumber = this.maskAccountNumber(obj.accountNumber);
    }
    return obj as BankAccount;
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  async create(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    dto: CreateBankAccountDto,
  ): Promise<BankAccount> {
    return withFinanceSpan(
      this.tracer,
      'finance.createBankAccount',
      { workspaceId: String(workspaceId), firmId: String(firmId) },
      async () => {
        // Enforce single-default: if isDefault=true, unset any existing default first
        if (dto.isDefault) {
          await this.model.updateMany(
            { workspaceId, firmId, isDefault: true, isDeleted: false },
            { isDefault: false },
          );
        }

        const openingBalance = dto.openingBalancePaise ?? 0;
        // Opening balance must be whole paise (T-F06W4: no fractional paise)
        if (!Number.isInteger(openingBalance)) {
          throw new BadRequestException('openingBalancePaise must be an integer (whole paise)');
        }

        const doc = new this.model({
          workspaceId,
          firmId,
          name: dto.name,
          bankName: dto.bankName,
          accountNumber: dto.accountNumber,
          ifscCode: dto.ifscCode,
          accountType: dto.accountType,
          openingBalancePaise: openingBalance,
          openingBalanceDate: dto.openingBalanceDate ? new Date(dto.openingBalanceDate) : undefined,
          currentBalancePaise: openingBalance, // starts at opening balance
          coaAccountCode: dto.coaAccountCode,
          coaAccountId: new Types.ObjectId(dto.coaAccountId),
          isDefault: dto.isDefault ?? false,
          upiId: dto.upiId,
          isDeleted: false,
        });

        const saved = await doc.save();
        return this.applyMask(saved);
      },
    );
  }

  async findAll(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    filters: ListBankAccountsDto,
  ): Promise<BankAccount[]> {
    const query: Record<string, any> = { workspaceId, firmId };

    if (filters.activeOnly !== false) {
      // Default: only return non-deleted accounts
      query.isDeleted = false;
    }
    if (filters.accountType) {
      query.accountType = filters.accountType;
    }

    const accounts = await this.model.find(query).sort({ name: 1 }).exec();
    return accounts.map((a) => this.applyMask(a));
  }

  async findById(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
  ): Promise<BankAccount> {
    const doc = await this.model
      .findOne({
        _id: new Types.ObjectId(id),
        workspaceId,
        firmId,
        isDeleted: false,
      })
      .exec();
    if (!doc) throw new NotFoundException(`BankAccount ${id} not found`);
    return this.applyMask(doc);
  }

  /**
   * Find by ObjectId — used internally by other services (cheques, loan EMI).
   * Does NOT apply masking since this is for internal use only.
   */
  async findByIdInternal(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: Types.ObjectId,
  ): Promise<BankAccount> {
    const doc = await this.model.findOne({ _id: id, workspaceId, firmId, isDeleted: false }).exec();
    if (!doc) throw new NotFoundException(`BankAccount ${String(id)} not found`);
    return doc;
  }

  async update(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
    dto: UpdateBankAccountDto,
  ): Promise<BankAccount> {
    return withFinanceSpan(
      this.tracer,
      'finance.updateBankAccount',
      { workspaceId: String(workspaceId), firmId: String(firmId) },
      async () => {
        const doc = await this.model
          .findOne({ _id: new Types.ObjectId(id), workspaceId, firmId, isDeleted: false })
          .exec();
        if (!doc) throw new NotFoundException(`BankAccount ${id} not found`);

        // If setting this as default, clear any existing default
        if (dto.isDefault === true && !doc.isDefault) {
          await this.model.updateMany(
            { workspaceId, firmId, isDefault: true, isDeleted: false },
            { isDefault: false },
          );
        }

        const allowedFields: (keyof UpdateBankAccountDto)[] = [
          'name',
          'bankName',
          'accountNumber',
          'ifscCode',
          'accountType',
          'isDefault',
          'upiId',
        ];
        for (const key of allowedFields) {
          if (key in dto && dto[key] !== undefined) {
            (doc as any)[key] = dto[key];
          }
        }

        const saved = await doc.save();
        return this.applyMask(saved);
      },
    );
  }

  async softDelete(workspaceId: Types.ObjectId, firmId: Types.ObjectId, id: string): Promise<void> {
    return withFinanceSpan(
      this.tracer,
      'finance.deleteBankAccount',
      { workspaceId: String(workspaceId), firmId: String(firmId) },
      async () => {
        const doc = await this.model
          .findOne({ _id: new Types.ObjectId(id), workspaceId, firmId, isDeleted: false })
          .exec();
        if (!doc) throw new NotFoundException(`BankAccount ${id} not found`);

        // Prevent deletion if the account has non-zero balance (accounting safety)
        if (doc.currentBalancePaise !== 0) {
          throw new BadRequestException(
            `Cannot delete bank account with non-zero balance (${doc.currentBalancePaise} paise). Please transfer or zero out the balance first.`,
          );
        }

        doc.isDeleted = true;
        doc.deletedAt = new Date();
        await doc.save();
      },
    );
  }

  // ─── Atomic balance operations ────────────────────────────────────────────

  /**
   * Atomically credit the bank account balance (e.g. when a received cheque clears).
   * Uses $inc for atomic update — never read-modify-write.
   *
   * @param accountId   BankAccount ObjectId
   * @param amountPaise Amount in paise (must be positive)
   * @param session     Mongoose session for transaction context
   * @param workspaceId Optional — when provided, scopes the update to prevent
   *                    cross-tenant mutation if a stale accountId is ever passed
   * @param firmId      Optional — same cross-tenant guard at firm level
   */
  async atomicCredit(
    accountId: Types.ObjectId,
    amountPaise: number,
    session?: ClientSession,
    workspaceId?: Types.ObjectId,
    firmId?: Types.ObjectId,
  ): Promise<void> {
    if (amountPaise <= 0) {
      throw new BadRequestException('amountPaise must be positive for credit');
    }
    const filter: Record<string, any> = { _id: accountId };
    if (workspaceId) filter.workspaceId = workspaceId;
    if (firmId) filter.firmId = firmId;
    await this.model.findOneAndUpdate(
      filter,
      { $inc: { currentBalancePaise: amountPaise } },
      { session },
    );
  }

  /**
   * Atomically debit the bank account balance (e.g. when an issued cheque clears).
   * Uses $inc with check-and-decrement — returns null if insufficient balance.
   *
   * @param accountId   BankAccount ObjectId
   * @param amountPaise Amount in paise (must be positive)
   * @param session     Mongoose session for transaction context
   * @param workspaceId Optional — when provided, scopes the update to prevent
   *                    cross-tenant mutation if a stale accountId is ever passed
   * @param firmId      Optional — same cross-tenant guard at firm level
   * @returns Updated document or null if insufficient balance
   */
  async atomicDebit(
    accountId: Types.ObjectId,
    amountPaise: number,
    session?: ClientSession,
    workspaceId?: Types.ObjectId,
    firmId?: Types.ObjectId,
  ): Promise<BankAccount | null> {
    if (amountPaise <= 0) {
      throw new BadRequestException('amountPaise must be positive for debit');
    }
    const filter: Record<string, any> = {
      _id: accountId,
      currentBalancePaise: { $gte: amountPaise }, // insufficient-balance guard
    };
    if (workspaceId) filter.workspaceId = workspaceId;
    if (firmId) filter.firmId = firmId;
    return this.model.findOneAndUpdate(
      filter,
      { $inc: { currentBalancePaise: -amountPaise } },
      { session, new: true },
    );
  }

  /**
   * Returns the default bank account for a firm, or null if none set.
   */
  async findDefault(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
  ): Promise<BankAccount | null> {
    const doc = await this.model
      .findOne({ workspaceId, firmId, isDefault: true, isDeleted: false })
      .exec();
    return doc ? this.applyMask(doc) : null;
  }

  // ─── Statement helpers ────────────────────────────────────────────────────

  /**
   * Maps LedgerEntry.entryType → frontend `sourceType` enum used by BankStatementTable.
   * Frontend recognises: sale | purchase | expense | journal | contra | pdc |
   *                      loan_emi | bounce | loan_disbursement
   */
  private mapEntryTypeToSourceType(entryType: string): string {
    switch (entryType) {
      case 'sale_invoice':
      case 'sale_invoice_reverse':
      case 'payment_in':
      case 'credit_note':
        return 'sale';
      case 'purchase_bill':
      case 'payment_out':
      case 'debit_note':
        return 'purchase';
      case 'expense':
      case 'expense_reversal':
        return 'expense';
      case 'journal':
        return 'journal';
      case 'contra':
        return 'contra';
      case 'cheque_pdc_mature':
        return 'pdc';
      case 'cheque_bounce':
        return 'bounce';
      case 'loan_emi':
        return 'loan_emi';
      case 'loan_disbursement':
        return 'loan_disbursement';
      default:
        return entryType;
    }
  }

  /**
   * Picks one bank-side LedgerLine (line.accountId equals the bank's coaAccountId)
   * and returns a string description sourced from the OTHER side of the journal
   * (the first non-bank line's accountName), falling back to entry.narration.
   */
  private particularsFromEntry(entry: LedgerEntry, bankCoaAccountId: Types.ObjectId): string {
    const otherLine = entry.lines.find((l) => !l.accountId.equals(bankCoaAccountId));
    if (otherLine) return otherLine.accountName;
    return entry.narration ?? '';
  }

  /**
   * Sums the bank-side net (credit − debit) of a LedgerEntry across all lines
   * matching the bank's coaAccountId. (Some entries have multiple bank-side
   * lines, e.g. cheque bounce reversals.)
   *
   * Returns { debitPaise, creditPaise } — both non-negative; only one is non-zero
   * when both legs collapse, but we sum each side independently to preserve the
   * raw Dr/Cr distinction shown in the UI.
   */
  private bankSideTotals(
    entry: LedgerEntry,
    bankCoaAccountId: Types.ObjectId,
  ): { debitPaise: number; creditPaise: number } {
    let debitPaise = 0;
    let creditPaise = 0;
    for (const line of entry.lines) {
      if (!line.accountId.equals(bankCoaAccountId)) continue;
      debitPaise += line.debit ?? 0;
      creditPaise += line.credit ?? 0;
    }
    return { debitPaise, creditPaise };
  }

  // ─── Statement query (Gap 1 — F-06-VERIFICATION SC-3) ─────────────────────

  /**
   * Returns paginated ledger rows touching this bank account within the given
   * date range, plus opening/closing balances.
   *
   * Filtering rules:
   *  - LedgerEntry.workspaceId + firmId must match (cross-firm leak guard, T-F06W7-01)
   *  - LedgerEntry.lines.accountId must equal bank.coaAccountId (the CoA sub-account
   *    the bank is bound to). LedgerLine.accountId is an ObjectId, so we use the
   *    bank.coaAccountId ObjectId directly — no string conversion.
   *  - entryDate within [from, to] inclusive when provided
   *
   * Running balance starts from `openingBalancePaise` (= bank.openingBalancePaise
   * + net of bank-side lines BEFORE fromDate) and accumulates (credit − debit)
   * for each row in chronological order.
   */
  async getStatement(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    bankAccountIdString: string,
    dto: GetStatementDto,
  ): Promise<{
    account: BankAccount;
    rows: Array<{
      date: string;
      voucherNo: string;
      sourceType: string;
      particulars: string;
      debitPaise: number;
      creditPaise: number;
      runningBalancePaise: number;
    }>;
    openingBalancePaise: number;
    closingBalancePaise: number;
    fromDate: string;
    toDate: string;
  }> {
    return withFinanceSpan(
      this.tracer,
      'finance.getBankStatement',
      { workspaceId: String(workspaceId), firmId: String(firmId) },
      async () => {
        // Auth + scope check via existing internal helper (throws NotFoundException
        // if the bank account is not in this workspace+firm).
        const bank = await this.findByIdInternal(
          workspaceId,
          firmId,
          new Types.ObjectId(bankAccountIdString),
        );

        const page = dto.page ?? 1;
        const limit = dto.limit ?? 100;

        const fromDate = dto.from ? new Date(dto.from) : null;
        const toDate = dto.to ? new Date(`${dto.to}T23:59:59.999Z`) : null;

        // ── Compute opening balance (bank.openingBalancePaise + net of bank-side
        //    lines BEFORE fromDate) ───────────────────────────────────────────────
        let openingBalancePaise = bank.openingBalancePaise ?? 0;

        if (fromDate) {
          const priorEntries = await this.ledgerEntryModel
            .find({
              workspaceId,
              firmId,
              'lines.accountId': bank.coaAccountId,
              entryDate: { $lt: fromDate },
            })
            .lean()
            .exec();
          for (const entry of priorEntries) {
            const { debitPaise, creditPaise } = this.bankSideTotals(
              entry as unknown as LedgerEntry,
              bank.coaAccountId,
            );
            openingBalancePaise += creditPaise - debitPaise;
          }
        }

        // ── Page of entries within the requested range ────────────────────────
        const rangeFilter: Record<string, any> = {
          workspaceId,
          firmId,
          'lines.accountId': bank.coaAccountId,
        };
        if (fromDate || toDate) {
          rangeFilter.entryDate = {};
          if (fromDate) rangeFilter.entryDate.$gte = fromDate;
          if (toDate) rangeFilter.entryDate.$lte = toDate;
        }

        // ── Adjust opening balance for skipped rows on page 2+ ───────────────
        // When page > 1, the running balance must start from the end of the
        // previous page's closing balance, not from the fromDate opening balance.
        const skipCount = (page - 1) * limit;
        if (skipCount > 0) {
          const skippedEntries = await this.ledgerEntryModel
            .find(rangeFilter)
            .sort({ entryDate: 1, postedAt: 1 })
            .limit(skipCount)
            .lean()
            .exec();
          for (const entry of skippedEntries) {
            const { debitPaise, creditPaise } = this.bankSideTotals(
              entry as unknown as LedgerEntry,
              bank.coaAccountId,
            );
            openingBalancePaise += creditPaise - debitPaise;
          }
        }

        const entries = await this.ledgerEntryModel
          .find(rangeFilter)
          .sort({ entryDate: 1, postedAt: 1 })
          .skip(skipCount)
          .limit(limit)
          .lean()
          .exec();

        // ── Build rows with running balance ───────────────────────────────────
        let running = openingBalancePaise;
        const rows = entries.map((entry) => {
          const { debitPaise, creditPaise } = this.bankSideTotals(
            entry as unknown as LedgerEntry,
            bank.coaAccountId,
          );
          running += creditPaise - debitPaise;
          const dateStr = (
            entry.entryDate instanceof Date ? entry.entryDate : new Date(entry.entryDate as any)
          )
            .toISOString()
            .slice(0, 10);
          return {
            date: dateStr,
            voucherNo: entry.sourceVoucherNumber,
            sourceType: this.mapEntryTypeToSourceType(entry.entryType),
            particulars: this.particularsFromEntry(
              entry as unknown as LedgerEntry,
              bank.coaAccountId,
            ),
            debitPaise,
            creditPaise,
            runningBalancePaise: running,
          };
        });

        const closingBalancePaise = rows.length > 0 ? running : openingBalancePaise;

        // Re-fetch via findById to return MASKED account (T-F06W7-03)
        const maskedAccount = await this.findById(workspaceId, firmId, bankAccountIdString);

        return {
          account: maskedAccount,
          rows,
          openingBalancePaise,
          closingBalancePaise,
          fromDate: dto.from ?? '',
          toDate: dto.to ?? '',
        };
      },
    );
  }
}
