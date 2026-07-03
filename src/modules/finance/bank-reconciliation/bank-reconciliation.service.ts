import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types, Connection } from 'mongoose';
import { InjectConnection } from '@nestjs/mongoose';
import { withFinanceSpan } from '../common/finance-observability';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { BankStatement } from './bank-statement.schema';
import { BankStatementRow } from './bank-statement-row.schema';
import { ReconciliationSession } from './reconciliation-session.schema';
import { LedgerEntry } from '../sales/ledger-posting/ledger-entry.schema';
import { BankAccount } from '../bank-accounts/bank-account.schema';
import { Firm } from '../firms/firm.schema';
import { BankStatementParserService } from './bank-statement-parser.service';
import { BrsReportService } from './brs-report.service';
import { GenericColumnMappingDto } from './dto/upload-statement.dto';
import { ManualMatchDto, BulkMatchDto } from './dto/manual-match.dto';
import { ExcludeRowDto } from './dto/exclude-row.dto';
import { ListRowsDto } from './dto/list-rows.dto';
import {
  AUTO_CLEAR_THRESHOLD,
  MatchableRow,
  MatchableEntry,
  rankCandidates,
  detectReversalPairs,
  validateBulkBalance,
} from './match-engine';
import { suggestCategory } from './narration-rules';
import { normaliseRef, normaliseNarration } from './parsers/parse-utils';
import { FyLockService } from '../fiscal-year/fy-lock.service';

// ─── Helper: Compute FY string from a date and firm FY start month ─────────

function computeFinancialYear(date: Date, fyStartMonth: number): string {
  const m = date.getUTCMonth() + 1; // 1-12
  const y = date.getUTCFullYear();
  if (m >= fyStartMonth) {
    // date falls in or after the start month of FY → FY is y-(y+1)
    return `${y}-${String(y + 1).slice(-2)}`;
  } else {
    // date is before start month → still in FY (y-1)-y
    return `${y - 1}-${String(y).slice(-2)}`;
  }
}

// ─── Helper: Date arithmetic ────────────────────────────────────────────────

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86400000);
}

// ─── Helper: Session + statement count recalculation ─────────────────────

async function recomputeStatementCounts(
  rowModel: Model<BankStatementRow>,
  statementModel: Model<BankStatement>,
  bankStatementId: Types.ObjectId,
): Promise<void> {
  const counts = await rowModel.aggregate([
    { $match: { bankStatementId } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        matched: { $sum: { $cond: [{ $eq: ['$status', 'matched'] }, 1, 0] } },
        unmatched: {
          $sum: {
            $cond: [{ $eq: ['$status', 'unmatched'] }, 1, 0],
          },
        },
      },
    },
  ]);
  if (counts.length > 0) {
    await statementModel.updateOne(
      { _id: bankStatementId },
      {
        $set: {
          matchedRows: counts[0].matched,
          unmatchedRows: counts[0].unmatched,
          totalRows: counts[0].total,
        },
      },
    );
  }
}

async function recomputeSessionCounts(
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
          $sum: {
            $cond: [{ $eq: ['$status', 'unmatched'] }, 1, 0],
          },
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
        // differenceExplained is intentionally NOT updated here — it was a stale
        // constant (bookBalance - statementClosingBalance) that never changed with
        // matching progress. The authoritative value is computed by BrsReportService.
      },
    },
  );
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class BankReconciliationService {
  // Platform-bar observability: shared finance tracer + PostHog. Spans wrap each
  // write; PostHog fires fire-and-forget after a successful write that carries a userId.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(BankStatement.name) private statementModel: Model<BankStatement>,
    @InjectModel(BankStatementRow.name) private rowModel: Model<BankStatementRow>,
    @InjectModel(ReconciliationSession.name) private sessionModel: Model<ReconciliationSession>,
    @InjectModel(LedgerEntry.name) private ledgerModel: Model<LedgerEntry>,
    @InjectModel(BankAccount.name) private bankAccountModel: Model<BankAccount>,
    @InjectModel(Firm.name) private firmModel: Model<Firm>,
    @InjectConnection() private readonly connection: Connection,
    private parser: BankStatementParserService,
    private brsReport: BrsReportService,
    private readonly fyLock: FyLockService,
    private readonly postHog: PostHogService,
  ) {}

  // ============== UPLOAD + CONFIRM ==============

  /**
   * Phase 1 - parse only, no DB write.
   * Returns preview structure for client.
   */
  async parseStatementPreview(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    bankAccountId: Types.ObjectId,
    buffer: Buffer,
    originalFilename: string,
    mapping?: GenericColumnMappingDto,
  ): Promise<{
    detectedFormat: string;
    rowCount: number;
    previewRows: any[];
    openingBalancePaise: number | null;
    closingBalancePaise: number | null;
    statementDateFrom: Date | null;
    statementDateTo: Date | null;
    warnings: string[];
    fyBoundaryWarning: boolean;
    openingBalanceChainWarning: string | null;
    durationFy: string | null;
  }> {
    // Verify bank account belongs to workspace/firm
    const bankAccount = await this.bankAccountModel.findOne({
      _id: bankAccountId,
      workspaceId: wsId,
      firmId,
      isDeleted: false,
    });
    if (!bankAccount) throw new NotFoundException('Bank account not found');

    // Load firm for FY config
    const firm = await this.firmModel.findOne({ _id: firmId, workspaceId: wsId });
    if (!firm) throw new NotFoundException('Firm not found');

    // Parse the statement (may throw BadRequestException with errorCode GENERIC_MAPPING_REQUIRED)
    let parseResult: Awaited<ReturnType<BankStatementParserService['parse']>>;
    try {
      parseResult = this.parser.parse(buffer, originalFilename, mapping as any);
    } catch (err) {
      // If GENERIC_MAPPING_REQUIRED, rethrow with column preview for the UI wizard
      if (err?.response?.errorCode === 'GENERIC_MAPPING_REQUIRED') {
        throw err;
      }
      throw err;
    }

    const fyStartMonth: number = (firm as any).fyStartMonth ?? 4;

    // FY boundary warning (RESEARCH Pitfall 6, Open Question 1 - warn, do not block)
    let fyBoundaryWarning = false;
    let durationFy: string | null = null;
    if (parseResult.statementDateFrom && parseResult.statementDateTo) {
      const fyFrom = computeFinancialYear(parseResult.statementDateFrom, fyStartMonth);
      const fyTo = computeFinancialYear(parseResult.statementDateTo, fyStartMonth);
      fyBoundaryWarning = fyFrom !== fyTo;
      durationFy = fyFrom;
    }

    // Opening balance chain validation (RESEARCH Open Question 1 - warn, do not block)
    let openingBalanceChainWarning: string | null = null;
    const lastStatement = await this.statementModel
      .findOne({ firmId, bankAccountId })
      .sort({ statementDateTo: -1 })
      .lean();
    if (lastStatement && parseResult.openingBalancePaise != null) {
      if (lastStatement.closingBalancePaise !== parseResult.openingBalancePaise) {
        const lastClose = (lastStatement.closingBalancePaise / 100).toFixed(2);
        const thisOpen = (parseResult.openingBalancePaise / 100).toFixed(2);
        openingBalanceChainWarning = `Last statement closed at ₹${lastClose}; this statement opens at ₹${thisOpen}`;
      }
    }

    // Duplicate check (RESEARCH Pitfall 7)
    if (parseResult.statementDateFrom && parseResult.statementDateTo) {
      const dupeCount = await this.statementModel.countDocuments({
        firmId,
        bankAccountId,
        statementDateFrom: parseResult.statementDateFrom,
        statementDateTo: parseResult.statementDateTo,
      });
      if (dupeCount > 0) {
        throw new ConflictException('Statement for this period already exists');
      }
    }

    return {
      detectedFormat: parseResult.detectedFormat,
      rowCount: parseResult.rows.length,
      previewRows: parseResult.rows.slice(0, 10),
      openingBalancePaise: parseResult.openingBalancePaise,
      closingBalancePaise: parseResult.closingBalancePaise,
      statementDateFrom: parseResult.statementDateFrom,
      statementDateTo: parseResult.statementDateTo,
      warnings: parseResult.warnings,
      fyBoundaryWarning,
      openingBalanceChainWarning,
      durationFy,
    };
  }

  /**
   * Phase 2 - persist BankStatement + N rows + create ReconciliationSession.
   */
  async confirmStatement(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    bankAccountId: Types.ObjectId,
    buffer: Buffer,
    originalFilename: string,
    importedByUserId: Types.ObjectId,
    mapping?: GenericColumnMappingDto,
  ): Promise<{ statementId: Types.ObjectId; sessionId: Types.ObjectId; totalRows: number }> {
    return withFinanceSpan(
      this.tracer,
      'finance.confirmBankStatement',
      { workspaceId: String(wsId), firmId: String(firmId), userId: String(importedByUserId) },
      async () => {
        const bankAccount = await this.bankAccountModel.findOne({
          _id: bankAccountId,
          workspaceId: wsId,
          firmId,
          isDeleted: false,
        });
        if (!bankAccount) throw new NotFoundException('Bank account not found');

        const firm = await this.firmModel.findOne({ _id: firmId, workspaceId: wsId });
        if (!firm) throw new NotFoundException('Firm not found');

        const parseResult = this.parser.parse(buffer, originalFilename, mapping as any);

        if (!parseResult.statementDateFrom || !parseResult.statementDateTo) {
          throw new BadRequestException('Statement contains no rows — cannot determine date range');
        }

        // Duplicate guard
        const dupeCount = await this.statementModel.countDocuments({
          firmId,
          bankAccountId,
          statementDateFrom: parseResult.statementDateFrom,
          statementDateTo: parseResult.statementDateTo,
        });
        if (dupeCount > 0) {
          throw new ConflictException('Statement for this period already exists');
        }

        const fyStartMonth: number = (firm as any).fyStartMonth ?? 4;
        const financialYear = computeFinancialYear(parseResult.statementDateFrom, fyStartMonth);

        // Compute book balance (ledger sum up to statementDateTo)
        const coaCode = bankAccount.coaAccountCode;
        const bookBalanceAgg = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsId,
              firmId,
              'lines.accountCode': coaCode,
              entryDate: { $lte: parseResult.statementDateTo },
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
        const bookBalancePaise =
          bookBalanceAgg.length > 0
            ? bookBalanceAgg[0].totalDebit - bookBalanceAgg[0].totalCredit
            : 0;

        // Build session name from bank account name + statement period month/year
        const statementDateTo = parseResult.statementDateTo;
        const monthName = statementDateTo.toLocaleString('default', {
          month: 'long',
          timeZone: 'UTC',
        });
        const year = statementDateTo.getUTCFullYear();
        const sessionName = `${bankAccount.name} ${monthName} ${year} Reconciliation`;

        // Atomic transaction
        const mongoSession = await this.connection.startSession();
        let statementId!: Types.ObjectId;
        let sessionId!: Types.ObjectId;

        await mongoSession.withTransaction(async () => {
          // Create BankStatement
          const [stmtDoc] = await this.statementModel.create(
            [
              {
                workspaceId: wsId,
                firmId,
                bankAccountId,
                bankName: parseResult.detectedFormat,
                detectedFormat: parseResult.detectedFormat,
                statementDateFrom: parseResult.statementDateFrom,
                statementDateTo: parseResult.statementDateTo,
                financialYear,
                openingBalancePaise: parseResult.openingBalancePaise ?? 0,
                closingBalancePaise: parseResult.closingBalancePaise ?? 0,
                totalRows: parseResult.rows.length,
                matchedRows: 0,
                unmatchedRows: parseResult.rows.length,
                status: 'imported',
                importedBy: importedByUserId,
                importedAt: new Date(),
                originalFilename,
              },
            ],
            { session: mongoSession },
          );
          statementId = stmtDoc._id;

          // Bulk insert rows
          const rowDocs = parseResult.rows.map((r) => ({
            workspaceId: wsId,
            firmId,
            bankStatementId: statementId,
            bankAccountId,
            rowIndex: r.rowIndex,
            txnDate: r.txnDate,
            valueDate: r.valueDate,
            narration: r.narration,
            narrationNorm: normaliseNarration(r.narration),
            refNumber: r.refNumber,
            refNumberNorm: r.refNumber ? normaliseRef(r.refNumber) : undefined,
            debitPaise: r.debitPaise,
            creditPaise: r.creditPaise,
            amountPaise: r.amountPaise,
            closingBalancePaise: r.closingBalancePaise,
            status: 'unmatched',
            matchedLedgerEntryIds: [],
            matchedVoucherIds: [],
            matchedVoucherTypes: [],
            topSuggestions: [],
          }));

          await this.rowModel.insertMany(rowDocs, { session: mongoSession });

          // Create ReconciliationSession
          const [sessDoc] = await this.sessionModel.create(
            [
              {
                workspaceId: wsId,
                firmId,
                bankAccountId,
                bankStatementId: statementId,
                sessionName,
                periodFrom: parseResult.statementDateFrom,
                periodTo: parseResult.statementDateTo,
                financialYear,
                bookBalancePaise,
                statementClosingBalancePaise: parseResult.closingBalancePaise ?? 0,
                differenceExplained: bookBalancePaise - (parseResult.closingBalancePaise ?? 0),
                status: 'draft',
                autoMatchRun: false,
                autoMatchedCount: 0,
                totalMatchedCount: 0,
                totalUnmatchedCount: parseResult.rows.length,
                outstandingChequesPaise: 0,
                depositsInTransitPaise: 0,
                createdBy: importedByUserId,
              },
            ],
            { session: mongoSession },
          );
          sessionId = sessDoc._id;
        });

        await mongoSession.endSession();

        // Fire-and-forget product analytics on the successful import (ids/counts only, no PII).
        this.postHog?.capture({
          distinctId: String(importedByUserId),
          event: 'banking.imported_bank_statement',
          properties: {
            workspaceId: String(wsId),
            firmId: String(firmId),
            bankAccountId: String(bankAccountId),
            statementId: String(statementId),
            sessionId: String(sessionId),
            totalRows: parseResult.rows.length,
          },
        });

        return { statementId, sessionId, totalRows: parseResult.rows.length };
      },
    );
  }

  // ============== SESSION OPS ==============

  async listStatements(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    bankAccountId: Types.ObjectId,
    skip = 0,
    limit = 20,
  ): Promise<{ items: BankStatement[]; total: number }> {
    const filter = { workspaceId: wsId, firmId, bankAccountId };
    const [items, total] = await Promise.all([
      this.statementModel.find(filter).sort({ statementDateTo: -1 }).skip(skip).limit(limit),
      this.statementModel.countDocuments(filter),
    ]);
    return { items, total };
  }

  async getStatement(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    statementId: Types.ObjectId,
  ): Promise<BankStatement> {
    const stmt = await this.statementModel.findOne({
      _id: statementId,
      workspaceId: wsId,
      firmId,
    });
    if (!stmt) throw new NotFoundException('Statement not found');
    return stmt;
  }

  async deleteStatement(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    statementId: Types.ObjectId,
  ): Promise<void> {
    return withFinanceSpan(
      this.tracer,
      'finance.deleteBankStatement',
      { workspaceId: String(wsId), firmId: String(firmId) },
      async () => {
        const stmt = await this.statementModel.findOne({
          _id: statementId,
          workspaceId: wsId,
          firmId,
        });
        if (!stmt) throw new NotFoundException('Statement not found');
        if (stmt.status === 'locked') {
          throw new ForbiddenException('Cannot delete a locked statement');
        }

        // Delete all rows + session + statement atomically to prevent orphaned documents
        const mongoSession = await this.connection.startSession();
        await mongoSession.withTransaction(async () => {
          await this.rowModel.deleteMany(
            { bankStatementId: statementId },
            { session: mongoSession },
          );
          await this.sessionModel.deleteMany(
            { bankStatementId: statementId },
            { session: mongoSession },
          );
          await this.statementModel.deleteOne({ _id: statementId }, { session: mongoSession });
        });
        await mongoSession.endSession();
      },
    );
  }

  async listSessions(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    bankAccountId: Types.ObjectId,
  ): Promise<ReconciliationSession[]> {
    return this.sessionModel
      .find({ workspaceId: wsId, firmId, bankAccountId })
      .sort({ createdAt: -1 });
  }

  async getSession(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    sessionId: Types.ObjectId,
  ): Promise<ReconciliationSession> {
    const sess = await this.sessionModel.findOne({
      _id: sessionId,
      workspaceId: wsId,
      firmId,
    });
    if (!sess) throw new NotFoundException('Session not found');
    return sess;
  }

  // ============== MATCHING ==============

  /**
   * Run 6-tier cascade on all unmatched rows.
   * Persist top-3 suggestions per row.
   * Auto-clear rows above AUTO_CLEAR_THRESHOLD (90).
   * Step 6: reversal pairs detected first (cheapest, no entry lookup).
   */
  async runAutoMatch(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    sessionId: Types.ObjectId,
    runByUserId: Types.ObjectId,
  ): Promise<{
    scanned: number;
    autoCleared: number;
    suggested: number;
    reversalPairs: number;
  }> {
    return withFinanceSpan(
      this.tracer,
      'finance.runReconciliationAutoMatch',
      { workspaceId: String(wsId), firmId: String(firmId), userId: String(runByUserId) },
      async () => {
        const session = await this.sessionModel.findOne({
          _id: sessionId,
          workspaceId: wsId,
          firmId,
        });
        if (!session) throw new NotFoundException('Session not found');
        if (session.status === 'locked') throw new ForbiddenException('Session is locked');

        const bankAccount = await this.bankAccountModel.findOne({
          _id: session.bankAccountId,
          workspaceId: wsId,
          firmId,
        });
        if (!bankAccount) throw new NotFoundException('Bank account not found');

        const statement = await this.statementModel.findOne({
          _id: session.bankStatementId,
          workspaceId: wsId,
          firmId,
        });
        if (!statement) throw new NotFoundException('Statement not found');

        // Load all unmatched rows
        const unmatchedRowDocs = await this.rowModel.find({
          bankStatementId: session.bankStatementId,
          status: 'unmatched',
        });

        const scanned = unmatchedRowDocs.length;
        let autoCleared = 0;
        let suggested = 0;
        let reversalPairsCount = 0;

        if (scanned === 0) {
          await this.sessionModel.updateOne({ _id: sessionId }, { $set: { autoMatchRun: true } });
          return { scanned: 0, autoCleared: 0, suggested: 0, reversalPairs: 0 };
        }

        // Convert to MatchableRow
        const matchableRows: MatchableRow[] = unmatchedRowDocs.map((r) => ({
          _id: r._id,
          txnDate: r.txnDate,
          narrationNorm: r.narrationNorm || '',
          refNumberNorm: r.refNumberNorm || '',
          debitPaise: r.debitPaise,
          creditPaise: r.creditPaise,
          amountPaise: r.amountPaise,
        }));

        // STEP 6 FIRST: Reversal pair detection (cheapest, within bank rows only)
        const reversalPairs = detectReversalPairs(matchableRows);
        const reversalRowIdSet = new Set<string>();
        for (const [idA, idB] of reversalPairs) {
          reversalRowIdSet.add(idA.toString());
          reversalRowIdSet.add(idB.toString());
          const now = new Date();
          // Store reversalPairRowId on each row individually so unmatch can find
          // the precise partner even when multiple same-amount reversal pairs exist.
          await this.rowModel.updateOne(
            { _id: idA },
            {
              $set: {
                status: 'matched',
                matchType: 'reversal_pair',
                matchConfidence: 100,
                matchedLedgerEntryIds: [],
                matchedVoucherIds: [],
                matchedVoucherTypes: [],
                matchedBy: runByUserId,
                matchedAt: now,
                topSuggestions: [],
                reversalPairRowId: idB,
              },
            },
          );
          await this.rowModel.updateOne(
            { _id: idB },
            {
              $set: {
                status: 'matched',
                matchType: 'reversal_pair',
                matchConfidence: 100,
                matchedLedgerEntryIds: [],
                matchedVoucherIds: [],
                matchedVoucherTypes: [],
                matchedBy: runByUserId,
                matchedAt: now,
                topSuggestions: [],
                reversalPairRowId: idA,
              },
            },
          );
          reversalPairsCount++;
          autoCleared += 2;
        }

        // Remove reversal-pair rows from pool before candidate matching
        const remainingRows = matchableRows.filter((r) => !reversalRowIdSet.has(r._id.toString()));

        if (remainingRows.length === 0) {
          await this.updateSessionAfterAutoMatch(
            sessionId,
            session.bankStatementId,
            autoCleared,
            suggested,
            reversalPairsCount,
          );
          return { scanned, autoCleared, suggested, reversalPairs: reversalPairsCount };
        }

        // Build candidate pool: LedgerEntries touching this bank account, within ±7 days, not cleared
        const minDate = addDays(statement.statementDateFrom, -7);
        const maxDate = addDays(statement.statementDateTo, 7);

        const candidateEntries = await this.ledgerModel
          .find({
            workspaceId: wsId,
            firmId,
            'lines.accountCode': bankAccount.coaAccountCode,
            entryDate: { $gte: minDate, $lte: maxDate },
            clearedInReconciliation: false,
          })
          .lean();

        // Convert to MatchableEntry
        const matchableEntries: MatchableEntry[] = [];
        for (const entry of candidateEntries) {
          const bankLine = entry.lines.find((l) => l.accountCode === bankAccount.coaAccountCode);
          if (!bankLine) continue;
          const bankLineNetPaise = bankLine.debit - bankLine.credit;
          matchableEntries.push({
            _id: entry._id,
            entryDate: entry.entryDate,
            sourceVoucherId: entry.sourceVoucherId,
            sourceVoucherType: entry.sourceVoucherType,
            sourceVoucherNumber: entry.sourceVoucherNumber,
            entryType: entry.entryType,
            narration: entry.narration,
            bankLineDebitPaise: bankLine.debit,
            bankLineCreditPaise: bankLine.credit,
            bankLineNetPaise,
          });
        }

        // Score each remaining row against candidate pool
        const now = new Date();
        for (const row of remainingRows) {
          const topResults = rankCandidates(row, matchableEntries);
          const topSuggestions = topResults
            .filter((r) => r.confidence > 0)
            .map((r) => ({
              ledgerEntryId: r.ledgerEntryId,
              confidence: r.confidence,
              matchType: r.matchType,
            }));

          const best = topResults[0];

          if (best && best.confidence >= AUTO_CLEAR_THRESHOLD) {
            // Auto-clear
            await this.rowModel.updateOne(
              { _id: row._id },
              {
                $set: {
                  status: 'matched',
                  matchType: best.matchType,
                  matchedLedgerEntryIds: [best.ledgerEntryId],
                  matchConfidence: best.confidence,
                  matchedBy: runByUserId,
                  matchedAt: now,
                  topSuggestions,
                },
              },
            );
            // Atomic CAS: only update if not yet cleared (T-13-W3-03)
            await this.ledgerModel.updateOne(
              { _id: best.ledgerEntryId, clearedInReconciliation: false },
              {
                $set: {
                  clearedInReconciliation: true,
                  clearedInSessionId: sessionId,
                  clearedAt: now,
                },
                $push: {
                  auditLog: {
                    at: now,
                    by: runByUserId,
                    action: 'reconciliation_clear',
                    after: { clearedInSessionId: sessionId },
                  },
                },
              },
            );
            autoCleared++;
          } else if (topSuggestions.length > 0) {
            // Store suggestions only
            await this.rowModel.updateOne({ _id: row._id }, { $set: { topSuggestions } });
            suggested++;
          }
        }

        await this.updateSessionAfterAutoMatch(
          sessionId,
          session.bankStatementId,
          autoCleared,
          suggested,
          reversalPairsCount,
        );

        // Fire-and-forget product analytics on the auto-match run (ids/counts only, no PII).
        this.postHog?.capture({
          distinctId: String(runByUserId),
          event: 'banking.auto_matched_reconciliation',
          properties: {
            workspaceId: String(wsId),
            firmId: String(firmId),
            sessionId: String(sessionId),
            scanned,
            autoCleared,
            suggested,
            reversalPairs: reversalPairsCount,
          },
        });

        return { scanned, autoCleared, suggested, reversalPairs: reversalPairsCount };
      },
    );
  }

  private async updateSessionAfterAutoMatch(
    sessionId: Types.ObjectId,
    bankStatementId: Types.ObjectId,
    autoCleared: number,
    _suggested: number,
    _reversalPairs: number,
  ): Promise<void> {
    const counts = await this.rowModel.aggregate([
      { $match: { bankStatementId } },
      {
        $group: {
          _id: null,
          matched: {
            $sum: { $cond: [{ $in: ['$status', ['matched', 'new_voucher']] }, 1, 0] },
          },
          unmatched: { $sum: { $cond: [{ $eq: ['$status', 'unmatched'] }, 1, 0] } },
        },
      },
    ]);
    const totalMatched = counts.length > 0 ? counts[0].matched : 0;
    const totalUnmatched = counts.length > 0 ? counts[0].unmatched : 0;

    await this.sessionModel.updateOne(
      { _id: sessionId },
      {
        $set: {
          autoMatchRun: true,
          autoMatchedCount: autoCleared,
          totalMatchedCount: totalMatched,
          totalUnmatchedCount: totalUnmatched,
          status: 'in_progress',
        },
      },
    );
  }

  /**
   * Manual single or bulk match: row <-> 1+ ledgerEntries.
   */
  async manualMatch(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    sessionId: Types.ObjectId,
    rowId: Types.ObjectId,
    dto: ManualMatchDto,
    userId: Types.ObjectId,
  ): Promise<BankStatementRow> {
    return withFinanceSpan(
      this.tracer,
      'finance.manualMatchReconciliationRow',
      { workspaceId: String(wsId), firmId: String(firmId), userId: String(userId) },
      async () => {
        const session = await this.sessionModel.findOne({
          _id: sessionId,
          workspaceId: wsId,
          firmId,
        });
        if (!session) throw new NotFoundException('Session not found');
        if (session.status === 'locked') throw new ForbiddenException('Session is locked');

        const row = await this.rowModel.findOne({
          _id: rowId,
          workspaceId: wsId,
          firmId,
          bankStatementId: session.bankStatementId,
        });
        if (!row) throw new NotFoundException('Row not found');

        // F-15 Plan 03: FY-lock guard — refuse match if row's txn date in CLOSED FY
        if (row.txnDate) {
          await this.fyLock.assertOpen(wsId, firmId, row.txnDate);
        }

        const ledgerEntryIds = dto.ledgerEntryIds.map((id) => new Types.ObjectId(id));
        const entries: (LedgerEntry & { _id: Types.ObjectId })[] = [];

        for (const entryId of ledgerEntryIds) {
          const entry = await this.ledgerModel.findOne({ _id: entryId });
          if (!entry) throw new NotFoundException(`LedgerEntry ${String(entryId)} not found`);
          // T-13-W3-02: verify workspace/firm ownership — do NOT leak via 403
          if (
            entry.workspaceId.toString() !== wsId.toString() ||
            entry.firmId.toString() !== firmId.toString()
          ) {
            throw new NotFoundException(`LedgerEntry ${String(entryId)} not found`);
          }
          // T-13-W3-03: check not already cleared in another session
          if (
            entry.clearedInReconciliation &&
            entry.clearedInSessionId?.toString() !== sessionId.toString()
          ) {
            throw new ConflictException(
              `LedgerEntry ${String(entryId)} already cleared in another session`,
            );
          }
          entries.push(entry as LedgerEntry & { _id: Types.ObjectId });
        }

        // Validate balance for all manual matches (single and multi-entry)
        {
          const bankAccount = await this.bankAccountModel.findOne({
            _id: session.bankAccountId,
            workspaceId: wsId,
            firmId,
          });
          if (!bankAccount) throw new NotFoundException('Bank account not found');

          const matchableRow: MatchableRow = {
            _id: row._id,
            txnDate: row.txnDate,
            narrationNorm: row.narrationNorm || '',
            refNumberNorm: row.refNumberNorm || '',
            debitPaise: row.debitPaise,
            creditPaise: row.creditPaise,
            amountPaise: row.amountPaise,
          };
          const matchableEntries: MatchableEntry[] = entries.map((e) => {
            const bankLine = e.lines.find((l) => l.accountCode === bankAccount.coaAccountCode);
            const bankLineNetPaise = bankLine ? bankLine.debit - bankLine.credit : 0;
            return {
              _id: e._id,
              entryDate: e.entryDate,
              sourceVoucherId: e.sourceVoucherId,
              sourceVoucherType: e.sourceVoucherType,
              sourceVoucherNumber: e.sourceVoucherNumber,
              entryType: e.entryType,
              narration: e.narration,
              bankLineDebitPaise: bankLine?.debit ?? 0,
              bankLineCreditPaise: bankLine?.credit ?? 0,
              bankLineNetPaise,
            };
          });
          if (!validateBulkBalance([matchableRow], matchableEntries)) {
            throw new BadRequestException('Entry amounts do not balance with bank row amount');
          }
        }

        const now = new Date();

        // $set on each entry: clearedInReconciliation (T-13-W3-01: $set-only, never create)
        for (const entry of entries) {
          await this.ledgerModel.updateOne(
            { _id: entry._id, clearedInReconciliation: false },
            {
              $set: {
                clearedInReconciliation: true,
                clearedInSessionId: sessionId,
                clearedAt: now,
              },
              $push: {
                auditLog: {
                  at: now,
                  by: userId,
                  action: 'reconciliation_clear',
                  after: { clearedInSessionId: sessionId },
                },
              },
            },
          );
        }

        // Update row
        const updatedRow = await this.rowModel.findOneAndUpdate(
          { _id: rowId },
          {
            $set: {
              status: 'matched',
              matchType: 'manual',
              matchedLedgerEntryIds: ledgerEntryIds,
              matchedVoucherIds: entries.map((e) => e.sourceVoucherId),
              matchedVoucherTypes: entries.map((e) => e.sourceVoucherType),
              matchConfidence: 100,
              matchedBy: userId,
              matchedAt: now,
            },
          },
          { new: true },
        );
        if (!updatedRow) throw new NotFoundException('Row not found');

        await recomputeStatementCounts(this.rowModel, this.statementModel, session.bankStatementId);
        await recomputeSessionCounts(this.rowModel, this.sessionModel, session as any);

        // Fire-and-forget product analytics on the manual match (ids/counts only, no PII).
        this.postHog?.capture({
          distinctId: String(userId),
          event: 'banking.matched_reconciliation_row',
          properties: {
            workspaceId: String(wsId),
            firmId: String(firmId),
            sessionId: String(sessionId),
            rowId: String(rowId),
            entryCount: ledgerEntryIds.length,
          },
        });

        return updatedRow;
      },
    );
  }

  /**
   * Bulk many-to-many match: N rows <-> M ledgerEntries.
   */
  async bulkMatch(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    sessionId: Types.ObjectId,
    dto: BulkMatchDto,
    userId: Types.ObjectId,
  ): Promise<{ matched: number }> {
    return withFinanceSpan(
      this.tracer,
      'finance.bulkMatchReconciliation',
      { workspaceId: String(wsId), firmId: String(firmId), userId: String(userId) },
      async () => {
        const session = await this.sessionModel.findOne({
          _id: sessionId,
          workspaceId: wsId,
          firmId,
        });
        if (!session) throw new NotFoundException('Session not found');
        if (session.status === 'locked') throw new ForbiddenException('Session is locked');

        const bankAccount = await this.bankAccountModel.findOne({
          _id: session.bankAccountId,
          workspaceId: wsId,
          firmId,
        });
        if (!bankAccount) throw new NotFoundException('Bank account not found');

        const rowIds = dto.bankStatementRowIds.map((id) => new Types.ObjectId(id));
        const ledgerEntryIds = dto.ledgerEntryIds.map((id) => new Types.ObjectId(id));

        const rows = await this.rowModel.find({
          _id: { $in: rowIds },
          workspaceId: wsId,
          firmId,
          bankStatementId: session.bankStatementId,
        });
        if (rows.length !== rowIds.length) {
          throw new NotFoundException('One or more rows not found in this session');
        }

        const entries: (LedgerEntry & { _id: Types.ObjectId })[] = [];
        for (const entryId of ledgerEntryIds) {
          const entry = await this.ledgerModel.findOne({ _id: entryId });
          if (!entry) throw new NotFoundException(`LedgerEntry ${String(entryId)} not found`);
          if (
            entry.workspaceId.toString() !== wsId.toString() ||
            entry.firmId.toString() !== firmId.toString()
          ) {
            throw new NotFoundException(`LedgerEntry ${String(entryId)} not found`);
          }
          if (
            entry.clearedInReconciliation &&
            entry.clearedInSessionId?.toString() !== sessionId.toString()
          ) {
            throw new ConflictException(
              `LedgerEntry ${String(entryId)} already cleared in another session`,
            );
          }
          entries.push(entry as LedgerEntry & { _id: Types.ObjectId });
        }

        // Validate sum balance (T-13-W3-06)
        const matchableRows: MatchableRow[] = rows.map((r) => ({
          _id: r._id,
          txnDate: r.txnDate,
          narrationNorm: r.narrationNorm || '',
          refNumberNorm: r.refNumberNorm || '',
          debitPaise: r.debitPaise,
          creditPaise: r.creditPaise,
          amountPaise: r.amountPaise,
        }));
        const matchableEntries: MatchableEntry[] = entries.map((e) => {
          const bankLine = e.lines.find((l) => l.accountCode === bankAccount.coaAccountCode);
          const bankLineNetPaise = bankLine ? bankLine.debit - bankLine.credit : 0;
          return {
            _id: e._id,
            entryDate: e.entryDate,
            sourceVoucherId: e.sourceVoucherId,
            sourceVoucherType: e.sourceVoucherType,
            sourceVoucherNumber: e.sourceVoucherNumber,
            entryType: e.entryType,
            narration: e.narration,
            bankLineDebitPaise: bankLine?.debit ?? 0,
            bankLineCreditPaise: bankLine?.credit ?? 0,
            bankLineNetPaise,
          };
        });
        if (!validateBulkBalance(matchableRows, matchableEntries)) {
          throw new BadRequestException(
            'Row amounts do not balance with entry amounts (tolerance: INR 5)',
          );
        }

        const now = new Date();

        // $set on all entries
        for (const entry of entries) {
          await this.ledgerModel.updateOne(
            { _id: entry._id, clearedInReconciliation: false },
            {
              $set: {
                clearedInReconciliation: true,
                clearedInSessionId: sessionId,
                clearedAt: now,
              },
              $push: {
                auditLog: {
                  at: now,
                  by: userId,
                  action: 'reconciliation_clear',
                  after: { clearedInSessionId: sessionId },
                },
              },
            },
          );
        }

        // Update each row
        await this.rowModel.updateMany(
          { _id: { $in: rowIds } },
          {
            $set: {
              status: 'matched',
              matchType: 'bulk',
              matchedLedgerEntryIds: ledgerEntryIds,
              matchedVoucherIds: entries.map((e) => e.sourceVoucherId),
              matchedVoucherTypes: entries.map((e) => e.sourceVoucherType),
              matchConfidence: 100,
              matchedBy: userId,
              matchedAt: now,
            },
          },
        );

        await recomputeStatementCounts(this.rowModel, this.statementModel, session.bankStatementId);
        await recomputeSessionCounts(this.rowModel, this.sessionModel, session as any);

        // Fire-and-forget product analytics on the bulk match (ids/counts only, no PII).
        this.postHog?.capture({
          distinctId: String(userId),
          event: 'banking.bulk_matched_reconciliation',
          properties: {
            workspaceId: String(wsId),
            firmId: String(firmId),
            sessionId: String(sessionId),
            rowCount: rows.length,
            entryCount: ledgerEntryIds.length,
          },
        });

        return { matched: rows.length };
      },
    );
  }

  /**
   * Reverse a match: clear LedgerEntry flags, reset row to unmatched.
   */
  async unmatchRow(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    sessionId: Types.ObjectId,
    rowId: Types.ObjectId,
    userId: Types.ObjectId,
  ): Promise<BankStatementRow> {
    return withFinanceSpan(
      this.tracer,
      'finance.unmatchReconciliationRow',
      { workspaceId: String(wsId), firmId: String(firmId), userId: String(userId) },
      async () => {
        const session = await this.sessionModel.findOne({
          _id: sessionId,
          workspaceId: wsId,
          firmId,
        });
        if (!session) throw new NotFoundException('Session not found');
        if (session.status === 'locked') throw new ForbiddenException('Session is locked');

        const row = await this.rowModel.findOne({
          _id: rowId,
          workspaceId: wsId,
          firmId,
          bankStatementId: session.bankStatementId,
        });
        if (!row) throw new NotFoundException('Row not found');

        // F-15 Plan 03: FY-lock guard
        if (row.txnDate) {
          await this.fyLock.assertOpen(wsId, firmId, row.txnDate);
        }

        if (!['matched', 'new_voucher'].includes(row.status)) {
          throw new BadRequestException(`Row is not matched (status: ${row.status})`);
        }

        // If reversal pair, also unmatch paired row
        if (row.matchType === 'reversal_pair') {
          // Use the stored reversalPairRowId for precise partner lookup — avoids
          // ambiguity when multiple same-amount reversal pairs exist in the statement.
          const pairedRowQuery = (row as any).reversalPairRowId
            ? { _id: (row as any).reversalPairRowId, bankStatementId: session.bankStatementId }
            : {
                bankStatementId: session.bankStatementId,
                amountPaise: -row.amountPaise,
                matchType: 'reversal_pair',
                status: 'matched',
                _id: { $ne: rowId },
              };
          const pairedRow = await this.rowModel.findOne(pairedRowQuery);
          if (pairedRow) {
            await this.rowModel.updateOne(
              { _id: pairedRow._id },
              {
                $set: {
                  status: 'unmatched',
                  matchedLedgerEntryIds: [],
                  matchedVoucherIds: [],
                  matchedVoucherTypes: [],
                  matchConfidence: undefined,
                  matchType: undefined,
                  matchedBy: undefined,
                  matchedAt: undefined,
                  reversalPairRowId: undefined,
                },
              },
            );
          }
        }

        // Clear LedgerEntry flags for all matched entries
        const now = new Date();
        if (row.matchedLedgerEntryIds && row.matchedLedgerEntryIds.length > 0) {
          for (const entryId of row.matchedLedgerEntryIds) {
            await this.ledgerModel.updateOne(
              { _id: entryId },
              {
                $set: {
                  clearedInReconciliation: false,
                  clearedInSessionId: undefined,
                  clearedAt: undefined,
                },
                $push: {
                  auditLog: {
                    at: now,
                    by: userId,
                    action: 'reconciliation_unclear',
                    after: { clearedInReconciliation: false },
                  },
                },
              },
            );
          }
        }

        // Reset row (including reversalPairRowId to avoid stale partner references)
        const updatedRow = await this.rowModel.findOneAndUpdate(
          { _id: rowId },
          {
            $set: {
              status: 'unmatched',
              matchedLedgerEntryIds: [],
              matchedVoucherIds: [],
              matchedVoucherTypes: [],
              matchConfidence: undefined,
              matchType: undefined,
              matchedBy: undefined,
              matchedAt: undefined,
              reversalPairRowId: undefined,
            },
          },
          { new: true },
        );
        if (!updatedRow) throw new NotFoundException('Row not found');

        await recomputeStatementCounts(this.rowModel, this.statementModel, session.bankStatementId);
        await recomputeSessionCounts(this.rowModel, this.sessionModel, session as any);

        // Fire-and-forget product analytics on the unmatch (ids only, no PII).
        this.postHog?.capture({
          distinctId: String(userId),
          event: 'banking.unmatched_reconciliation_row',
          properties: {
            workspaceId: String(wsId),
            firmId: String(firmId),
            sessionId: String(sessionId),
            rowId: String(rowId),
          },
        });

        return updatedRow;
      },
    );
  }

  /**
   * Mark row as disputed/excluded with reason.
   * Excluded rows do NOT count toward unmatched (RESEARCH §4).
   */
  async excludeRow(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    sessionId: Types.ObjectId,
    rowId: Types.ObjectId,
    dto: ExcludeRowDto,
    _userId: Types.ObjectId,
  ): Promise<BankStatementRow> {
    return withFinanceSpan(
      this.tracer,
      'finance.excludeReconciliationRow',
      { workspaceId: String(wsId), firmId: String(firmId) },
      async () => {
        const session = await this.sessionModel.findOne({
          _id: sessionId,
          workspaceId: wsId,
          firmId,
        });
        if (!session) throw new NotFoundException('Session not found');
        if (session.status === 'locked') throw new ForbiddenException('Session is locked');

        const row = await this.rowModel.findOne({
          _id: rowId,
          workspaceId: wsId,
          firmId,
          bankStatementId: session.bankStatementId,
        });
        if (!row) throw new NotFoundException('Row not found');

        const updatedRow = await this.rowModel.findOneAndUpdate(
          { _id: rowId },
          { $set: { status: 'disputed', excludeReason: dto.reason ?? '' } },
          { new: true },
        );
        if (!updatedRow) throw new NotFoundException('Row not found');

        await recomputeSessionCounts(this.rowModel, this.sessionModel, session as any);
        return updatedRow;
      },
    );
  }

  async unexcludeRow(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    sessionId: Types.ObjectId,
    rowId: Types.ObjectId,
    _userId: Types.ObjectId,
  ): Promise<BankStatementRow> {
    return withFinanceSpan(
      this.tracer,
      'finance.unexcludeReconciliationRow',
      { workspaceId: String(wsId), firmId: String(firmId) },
      async () => {
        const session = await this.sessionModel.findOne({
          _id: sessionId,
          workspaceId: wsId,
          firmId,
        });
        if (!session) throw new NotFoundException('Session not found');
        if (session.status === 'locked') throw new ForbiddenException('Session is locked');

        const row = await this.rowModel.findOne({
          _id: rowId,
          workspaceId: wsId,
          firmId,
          bankStatementId: session.bankStatementId,
        });
        if (!row) throw new NotFoundException('Row not found');

        const updatedRow = await this.rowModel.findOneAndUpdate(
          { _id: rowId },
          { $set: { status: 'unmatched', excludeReason: undefined } },
          { new: true },
        );
        if (!updatedRow) throw new NotFoundException('Row not found');

        await recomputeSessionCounts(this.rowModel, this.sessionModel, session as any);
        return updatedRow;
      },
    );
  }

  // ============== LISTING + SUGGESTIONS ==============

  async listRows(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    sessionId: Types.ObjectId,
    query: ListRowsDto,
  ): Promise<{
    items: BankStatementRow[];
    total: number;
    summary: {
      unmatched: number;
      matched: number;
      excluded: number;
      disputed: number;
      new_voucher: number;
    };
  }> {
    const session = await this.sessionModel.findOne({
      _id: sessionId,
      workspaceId: wsId,
      firmId,
    });
    if (!session) throw new NotFoundException('Session not found');

    const filter: Record<string, any> = {
      bankStatementId: session.bankStatementId,
      workspaceId: wsId,
      firmId,
    };

    if (query.status && query.status !== 'all') {
      filter.status = query.status;
    }
    if (query.dateFrom) {
      filter.txnDate = { ...filter.txnDate, $gte: new Date(query.dateFrom) };
    }
    if (query.dateTo) {
      filter.txnDate = { ...filter.txnDate, $lte: new Date(query.dateTo) };
    }

    const skip = query.skip ?? 0;
    const limit = Math.min(query.limit ?? 50, 200);

    const [items, total, summaryCounts] = await Promise.all([
      this.rowModel.find(filter).sort({ rowIndex: 1 }).skip(skip).limit(limit),
      this.rowModel.countDocuments(filter),
      this.rowModel.aggregate([
        { $match: { bankStatementId: session.bankStatementId, workspaceId: wsId, firmId } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const summary = { unmatched: 0, matched: 0, excluded: 0, disputed: 0, new_voucher: 0 };
    for (const s of summaryCounts) {
      if (s._id in summary) {
        (summary as any)[s._id] = s.count;
      }
    }

    return { items, total, summary };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async signature kept for API stability; body is a sync suggester
  async getNarrationSuggestion(narrationNorm: string): Promise<ReturnType<typeof suggestCategory>> {
    return suggestCategory(narrationNorm);
  }

  /**
   * Get match candidates for a specific row.
   * Used when user opens "Link to Voucher" drawer.
   * Wider window (±30 days, ±10% amount) than auto-match.
   */
  async getCandidatesForRow(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    sessionId: Types.ObjectId,
    rowId: Types.ObjectId,
  ): Promise<MatchableEntry[]> {
    const session = await this.sessionModel.findOne({
      _id: sessionId,
      workspaceId: wsId,
      firmId,
    });
    if (!session) throw new NotFoundException('Session not found');

    const row = await this.rowModel.findOne({
      _id: rowId,
      workspaceId: wsId,
      firmId,
      bankStatementId: session.bankStatementId,
    });
    if (!row) throw new NotFoundException('Row not found');

    const bankAccount = await this.bankAccountModel.findOne({
      _id: session.bankAccountId,
      workspaceId: wsId,
      firmId,
    });
    if (!bankAccount) throw new NotFoundException('Bank account not found');

    const minDate = addDays(row.txnDate, -30);
    const maxDate = addDays(row.txnDate, 30);
    const absAmount = Math.abs(row.amountPaise);
    const amountMin = Math.floor(absAmount * 0.9);
    const amountMax = Math.ceil(absAmount * 1.1);

    const candidateEntries = await this.ledgerModel
      .find({
        workspaceId: wsId,
        firmId,
        'lines.accountCode': bankAccount.coaAccountCode,
        entryDate: { $gte: minDate, $lte: maxDate },
        clearedInReconciliation: false,
      })
      .lean();

    const result: MatchableEntry[] = [];
    for (const entry of candidateEntries) {
      const bankLine = entry.lines.find((l) => l.accountCode === bankAccount.coaAccountCode);
      if (!bankLine) continue;
      const bankLineNetPaise = bankLine.debit - bankLine.credit;
      const entryAbs = Math.abs(bankLineNetPaise);
      if (entryAbs < amountMin || entryAbs > amountMax) continue;
      result.push({
        _id: entry._id,
        entryDate: entry.entryDate,
        sourceVoucherId: entry.sourceVoucherId,
        sourceVoucherType: entry.sourceVoucherType,
        sourceVoucherNumber: entry.sourceVoucherNumber,
        entryType: entry.entryType,
        narration: entry.narration,
        bankLineDebitPaise: bankLine.debit,
        bankLineCreditPaise: bankLine.credit,
        bankLineNetPaise,
      });
    }

    // Sort by score desc
    const matchableRow: MatchableRow = {
      _id: row._id,
      txnDate: row.txnDate,
      narrationNorm: row.narrationNorm || '',
      refNumberNorm: row.refNumberNorm || '',
      debitPaise: row.debitPaise,
      creditPaise: row.creditPaise,
      amountPaise: row.amountPaise,
    };
    const ranked = rankCandidates(matchableRow, result);
    const rankedIds = ranked.map((r) => r.ledgerEntryId.toString());
    result.sort((a, b) => {
      const ia = rankedIds.indexOf(a._id.toString());
      const ib = rankedIds.indexOf(b._id.toString());
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });

    return result;
  }

  // ============== SESSION COMPLETION ==============

  /**
   * Validate, run BRS, and lock the session + associated statement atomically.
   * Moved from the controller to keep all Mongoose model access inside the service layer.
   */
  async completeSession(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    sessionId: Types.ObjectId,
    userId: Types.ObjectId,
    note?: string,
  ): Promise<{ completed: boolean; sessionId: string; lockedAt: Date }> {
    return withFinanceSpan(
      this.tracer,
      'finance.completeReconciliationSession',
      { workspaceId: String(wsId), firmId: String(firmId), userId: String(userId) },
      async () => {
        const session = await this.getSession(wsId, firmId, sessionId);

        // Guard: all rows must be matched before completion
        if ((session as any).totalUnmatchedCount > 0) {
          throw new BadRequestException(
            `Cannot complete session: ${(session as any).totalUnmatchedCount} unmatched rows remain`,
          );
        }

        // Run BRS to confirm zero difference
        const brsData = await this.brsReport.generate(wsId, firmId, sessionId);
        if (!brsData.isFullyReconciled) {
          throw new BadRequestException(
            `Cannot complete session: difference of ${brsData.differencePaise} paise remains unexplained`,
          );
        }

        const now = new Date();

        // Lock session
        await this.sessionModel.updateOne(
          { _id: sessionId },
          {
            $set: {
              status: 'completed',
              completedBy: userId,
              completedAt: now,
              ...(note ? { note } : {}),
            },
          },
        );

        // Lock the associated BankStatement
        await this.statementModel.updateOne(
          { _id: (session as any).bankStatementId },
          {
            $set: {
              status: 'locked',
              lockedBy: userId,
              lockedAt: now,
            },
          },
        );

        // Fire-and-forget product analytics on the successful reconciliation (ids only, no PII).
        this.postHog?.capture({
          distinctId: String(userId),
          event: 'banking.reconciled_statement',
          properties: {
            workspaceId: String(wsId),
            firmId: String(firmId),
            sessionId: String(sessionId),
          },
        });

        return { completed: true, sessionId: sessionId.toString(), lockedAt: now };
      },
    );
  }
}
