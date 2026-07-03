import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types, Connection } from 'mongoose';
import { withFinanceSpan } from '../common/finance-observability';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { BankStatementRow } from './bank-statement-row.schema';
import { ReconciliationSession } from './reconciliation-session.schema';
import { BankStatement } from './bank-statement.schema';
import { LedgerEntry } from '../sales/ledger-posting/ledger-entry.schema';
import { BankAccount } from '../bank-accounts/bank-account.schema';
import { Account } from '../ledger/account.schema';
import { CreateFromRowDto } from './dto/create-from-row.dto';
import { stripCsvFormulaPrefix } from './parsers/parse-utils';

// ─── GST rate → input CoA code mapping ──────────────────────────────────────
// CGST input codes per COA seed (F-04 / F-13 COA seed)
const GST_RATE_TO_COA_CODE: Record<number, string> = {
  5: '2003.05',
  12: '2003.12',
  18: '2003.18',
  28: '2003.28',
};

// ─── Helper ──────────────────────────────────────────────────────────────────

async function recomputeSessionCountsLocal(
  rowModel: Model<BankStatementRow>,
  sessionModel: Model<ReconciliationSession>,
  session: ReconciliationSession & { _id: Types.ObjectId },
): Promise<void> {
  const counts = await rowModel.aggregate([
    { $match: { bankStatementId: session.bankStatementId } },
    {
      $group: {
        _id: null,
        matched: {
          $sum: {
            $cond: [{ $in: ['$status', ['matched', 'new_voucher']] }, 1, 0],
          },
        },
        unmatched: {
          $sum: { $cond: [{ $eq: ['$status', 'unmatched'] }, 1, 0] },
        },
      },
    },
  ]);
  const totalMatched = counts.length > 0 ? counts[0].matched : 0;
  const totalUnmatched = counts.length > 0 ? counts[0].unmatched : 0;
  await sessionModel.updateOne(
    { _id: session._id },
    {
      $set: {
        totalMatchedCount: totalMatched,
        totalUnmatchedCount: totalUnmatched,
        differenceExplained: session.bookBalancePaise - session.statementClosingBalancePaise,
      },
    },
  );
}

// ─── CreateFromRowService ─────────────────────────────────────────────────────

@Injectable()
export class CreateFromRowService {
  // Platform-bar observability: shared finance tracer + PostHog. Span wraps the
  // write; PostHog fires fire-and-forget after the new voucher is created.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(BankStatementRow.name)
    private readonly rowModel: Model<BankStatementRow>,
    @InjectModel(ReconciliationSession.name)
    private readonly sessionModel: Model<ReconciliationSession>,
    @InjectModel(BankStatement.name)
    private readonly statementModel: Model<BankStatement>,
    @InjectModel(LedgerEntry.name)
    private readonly ledgerModel: Model<LedgerEntry>,
    @InjectModel(BankAccount.name)
    private readonly bankAccountModel: Model<BankAccount>,
    @InjectModel(Account.name)
    private readonly accountModel: Model<Account>,
    @InjectConnection()
    private readonly connection: Connection,
    private readonly postHog: PostHogService,
  ) {}

  /**
   * Atomic operation: creates a LedgerEntry from an unmatched bank statement row
   * and links the row to the new entry.
   *
   * Transaction steps:
   *   1. Validate row/session/bankAccount exist in (wsId, firmId).
   *   2. Validate row.status === 'unmatched' and session.status !== 'locked'.
   *   3. Validate dto.coaAccountId belongs to (wsId, firmId).
   *   4. Build LedgerEntry lines based on row direction (debit vs credit row).
   *      If gstRatePercent > 0: compute inclusive GST amount and split lines.
   *   5. Create LedgerEntry with entryType='bank_reconciliation_new',
   *      sourceVoucherType='bank_reconciliation_row', clearedInReconciliation=true.
   *   6. Update row: status='new_voucher', matchedLedgerEntryIds=[entry._id].
   *   7. Recompute session counts.
   *
   * Direction logic:
   *   - Row debit (amountPaise < 0): money left bank. Bank credit, dto account debit.
   *     e.g. Bank Charges: Dr Bank Charges 5008 | Cr HDFC Bank 1002.001
   *   - Row credit (amountPaise > 0): money entered bank. Bank debit, dto account credit.
   *     e.g. Interest Income: Dr HDFC Bank 1002.001 | Cr Interest Income 4003
   */
  async create(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    sessionId: Types.ObjectId,
    rowId: Types.ObjectId,
    dto: CreateFromRowDto,
    userId: Types.ObjectId,
  ): Promise<{ ledgerEntryId: Types.ObjectId; rowId: Types.ObjectId }> {
    return withFinanceSpan(
      this.tracer,
      'finance.createVoucherFromBankRow',
      { workspaceId: String(wsId), firmId: String(firmId), userId: String(userId) },
      async () => {
        // ── Validate row ──────────────────────────────────────────────────────
        const row = await this.rowModel
          .findOne({ _id: rowId, workspaceId: wsId, firmId })
          .lean<BankStatementRow & { _id: Types.ObjectId }>();
        if (!row) throw new NotFoundException('Bank statement row not found');
        if (row.status !== 'unmatched') {
          throw new BadRequestException(
            `Row is already in status '${row.status}'; only unmatched rows can create a voucher`,
          );
        }

        // ── Validate session ──────────────────────────────────────────────────
        const session = await this.sessionModel
          .findOne({ _id: sessionId, workspaceId: wsId, firmId })
          .lean<ReconciliationSession & { _id: Types.ObjectId }>();
        if (!session) throw new NotFoundException('Reconciliation session not found');
        if (session.status === 'locked') {
          throw new ConflictException('Session is locked; no changes allowed');
        }

        // ── Validate bank account ─────────────────────────────────────────────
        const bankAccount = await this.bankAccountModel
          .findOne({ _id: row.bankAccountId, workspaceId: wsId, firmId, isDeleted: false })
          .lean<BankAccount & { _id: Types.ObjectId }>();
        if (!bankAccount) throw new NotFoundException('Bank account not found');

        // ── Validate dto CoA account ──────────────────────────────────────────
        const coaAccount = await this.accountModel
          .findOne({
            _id: new Types.ObjectId(dto.coaAccountId),
            workspaceId: wsId,
            firmId,
            isDeleted: false,
          })
          .lean<Account & { _id: Types.ObjectId }>();
        if (!coaAccount) {
          throw new BadRequestException('CoA account not found in this firm');
        }

        // ── Determine narration ───────────────────────────────────────────────
        const rawNarration = dto.narration ?? row.narration;
        const sanitisedNarration = stripCsvFormulaPrefix(rawNarration);
        const narration = `[Bank Recon] ${sanitisedNarration}`;

        // ── Build ledger lines ────────────────────────────────────────────────
        const absAmountPaise = Math.abs(row.amountPaise);
        const isDebitRow = row.amountPaise < 0; // debit = money left bank

        // Determine CoA IDs / codes for the bank account line
        const bankAccountId = bankAccount.coaAccountId;
        const bankAccountCode = bankAccount.coaAccountCode;
        const bankAccountName = bankAccount.name;

        let lines: Array<{
          accountId: Types.ObjectId;
          accountCode: string;
          accountName: string;
          debit: number;
          credit: number;
        }> = [];

        if (!dto.gstRatePercent || dto.gstRatePercent === 0) {
          // No GST — simple 2-line entry
          if (isDebitRow) {
            // Dr dto account | Cr bank account
            lines = [
              {
                accountId: coaAccount._id,
                accountCode: dto.coaAccountCode,
                accountName: coaAccount.name,
                debit: absAmountPaise,
                credit: 0,
              },
              {
                accountId: bankAccountId,
                accountCode: bankAccountCode,
                accountName: bankAccountName,
                debit: 0,
                credit: absAmountPaise,
              },
            ];
          } else {
            // Credit row: Dr bank account | Cr dto account
            lines = [
              {
                accountId: bankAccountId,
                accountCode: bankAccountCode,
                accountName: bankAccountName,
                debit: absAmountPaise,
                credit: 0,
              },
              {
                accountId: coaAccount._id,
                accountCode: dto.coaAccountCode,
                accountName: coaAccount.name,
                debit: 0,
                credit: absAmountPaise,
              },
            ];
          }
        } else {
          // GST handling — inclusive-of-tax assumption
          const rate = dto.gstRatePercent;
          const gstCoaCode = GST_RATE_TO_COA_CODE[rate];
          if (!gstCoaCode) {
            throw new BadRequestException(
              `Unsupported GST rate ${rate}%; supported rates: 5, 12, 18, 28`,
            );
          }
          // Look up GST CoA account
          const gstAccount = await this.accountModel
            .findOne({ workspaceId: wsId, firmId, code: gstCoaCode, isDeleted: false })
            .lean<Account & { _id: Types.ObjectId }>();
          if (!gstAccount) {
            throw new BadRequestException(
              `GST input CoA account '${gstCoaCode}' not seeded for this firm`,
            );
          }

          // Inclusive GST: gst = round(absAmount * rate / (100 + rate))
          const gstPaise = Math.round((absAmountPaise * rate) / (100 + rate));
          const netPaise = absAmountPaise - gstPaise;

          if (isDebitRow) {
            // Dr dto account (net) | Dr GST input | Cr bank account (gross)
            lines = [
              {
                accountId: coaAccount._id,
                accountCode: dto.coaAccountCode,
                accountName: coaAccount.name,
                debit: netPaise,
                credit: 0,
              },
              {
                accountId: gstAccount._id,
                accountCode: gstCoaCode,
                accountName: gstAccount.name,
                debit: gstPaise,
                credit: 0,
              },
              {
                accountId: bankAccountId,
                accountCode: bankAccountCode,
                accountName: bankAccountName,
                debit: 0,
                credit: absAmountPaise,
              },
            ];
          } else {
            // Credit row: Dr bank account (gross) | Cr dto account (net) | Cr GST output
            lines = [
              {
                accountId: bankAccountId,
                accountCode: bankAccountCode,
                accountName: bankAccountName,
                debit: absAmountPaise,
                credit: 0,
              },
              {
                accountId: coaAccount._id,
                accountCode: dto.coaAccountCode,
                accountName: coaAccount.name,
                debit: 0,
                credit: netPaise,
              },
              {
                accountId: gstAccount._id,
                accountCode: gstCoaCode,
                accountName: gstAccount.name,
                debit: 0,
                credit: gstPaise,
              },
            ];
          }
        }

        // ── Transactional create ──────────────────────────────────────────────
        const mongoSession = await this.connection.startSession();
        let newLedgerEntryId!: Types.ObjectId;

        await mongoSession.withTransaction(async () => {
          const now = new Date();

          // 1. Create LedgerEntry
          const [entry] = await this.ledgerModel.create(
            [
              {
                workspaceId: wsId,
                firmId,
                financialYear: session.financialYear,
                entryDate: row.txnDate,
                entryType: 'bank_reconciliation_new',
                sourceVoucherId: rowId,
                sourceVoucherType: 'bank_reconciliation_row',
                sourceVoucherNumber: String(row.rowIndex),
                narration,
                lines,
                isReversed: false,
                postedBy: userId,
                postedAt: now,
                auditLog: [
                  {
                    at: now,
                    by: userId,
                    action: 'reconciliation_new_voucher',
                    after: { rowId: String(rowId), sessionId: String(sessionId) },
                  },
                ],
                // Born cleared — this entry is created from the bank row directly
                clearedInReconciliation: true,
                clearedInSessionId: sessionId,
                clearedAt: now,
              },
            ],
            { session: mongoSession },
          );
          newLedgerEntryId = entry._id;

          // 2. Update the bank statement row
          await this.rowModel.updateOne(
            { _id: rowId },
            {
              $set: {
                status: 'new_voucher',
                matchedLedgerEntryIds: [newLedgerEntryId],
                matchType: 'manual',
                matchedBy: userId,
                matchedAt: now,
                newVoucherType: dto.entryType,
              },
            },
            { session: mongoSession },
          );
        });

        await mongoSession.endSession();

        // 3. Recompute session counts (outside transaction for simplicity)
        await recomputeSessionCountsLocal(this.rowModel, this.sessionModel, session);

        // Fire-and-forget product analytics on the new voucher (ids/type only, no PII).
        this.postHog.capture({
          distinctId: String(userId),
          event: 'banking.created_voucher_from_bank_row',
          properties: {
            workspaceId: String(wsId),
            firmId: String(firmId),
            sessionId: String(sessionId),
            rowId: String(rowId),
            ledgerEntryId: String(newLedgerEntryId),
            entryType: dto.entryType,
          },
        });

        return { ledgerEntryId: newLedgerEntryId, rowId };
      },
    );
  }
}
