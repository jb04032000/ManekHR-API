import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Connection, Model, Types } from 'mongoose';
import { withFinanceSpan } from '../common/finance-observability';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { LoanAccount } from './loan-account.schema';
import { LoanScheduleEntry } from './loan-schedule-entry.schema';
import { LoanEmiRun } from './loan-emi-run.schema';
import { LedgerPostingService } from '../sales/ledger-posting/ledger-posting.service';
import { VoucherSeriesService } from '../voucher-series/voucher-series.service';
import { FirmsService } from '../firms/firms.service';
import { LoanScheduleService } from './loan-schedule.service';
import { CreateLoanAccountDto } from './dto/create-loan-account.dto';
import { ListLoanAccountsDto } from './dto/list-loan-accounts.dto';
import { RecordDisbursementDto } from './dto/record-disbursement.dto';
import { PrepayLoanDto } from './dto/prepay-loan.dto';
import { PreviewScheduleDto } from './dto/preview-schedule.dto';
import { ScheduleRow } from './loan-schedule.service';

/**
 * LoanAccountsService — manages term loans, OD, and CC facilities.
 *
 * Key responsibilities:
 *  - Create loan account with EMI schedule generation (reducing-balance formula)
 *  - Record disbursement: Dr Bank / Cr Loan Liability
 *  - Close / mark NPA
 *  - runEmiForMonth: idempotent EMI posting via LoanEmiRun guard
 *    Dr Loan Liability (principal) + Dr 5015 Interest / Cr Bank
 *  - Monthly EMI cron: processEmiForMonth(runMonth) — called by SchedulerService
 *
 * EMI formula (reducing balance):
 *   r = interestRateAnnual / 12 / 100
 *   EMI = P × r × (1+r)^n / ((1+r)^n − 1)
 *
 * Security: all queries scoped by workspaceId + firmId.
 */
@Injectable()
export class LoanAccountsService {
  constructor(
    @InjectModel(LoanAccount.name)
    private readonly loanModel: Model<LoanAccount>,
    @InjectModel(LoanScheduleEntry.name)
    private readonly scheduleModel: Model<LoanScheduleEntry>,
    @InjectModel(LoanEmiRun.name)
    private readonly emiRunModel: Model<LoanEmiRun>,
    @InjectConnection()
    private readonly conn: Connection,
    private readonly ledgerPostingService: LedgerPostingService,
    private readonly voucherSeriesService: VoucherSeriesService,
    private readonly firmsService: FirmsService,
    private readonly loanScheduleService: LoanScheduleService,
    private readonly postHog: PostHogService,
  ) {}

  // Platform-bar observability: shared finance tracer. Spans wrap each write;
  // PostHog fires fire-and-forget after a successful write. Span attributes carry
  // ids / amounts only — never lender name or account numbers (PII rule).
  private readonly tracer = trace.getTracer('finance');

  // ─── EMI formula ──────────────────────────────────────────────────────────

  /**
   * Compute monthly EMI using reducing-balance formula.
   * Returns 0 for OD/CC (tenureMonths=0) — no fixed EMI.
   */
  private computeEmi(principalPaise: number, rateAnnual: number, tenureMonths: number): number {
    if (tenureMonths === 0 || rateAnnual === 0) return 0;
    const r = rateAnnual / 12 / 100;
    const n = tenureMonths;
    const emi = (principalPaise * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
    return Math.round(emi);
  }

  /** Generate amortisation schedule rows — returns full schedule array */
  private generateSchedule(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    loanAccountId: Types.ObjectId,
    principalPaise: number,
    rateAnnual: number,
    emiAmountPaise: number,
    tenureMonths: number,
    repaymentStartDate: Date,
  ): Array<{
    workspaceId: Types.ObjectId;
    firmId: Types.ObjectId;
    loanAccountId: Types.ObjectId;
    month: string;
    openingPrincipalPaise: number;
    emiAmountPaise: number;
    principalComponentPaise: number;
    interestComponentPaise: number;
    closingPrincipalPaise: number;
    status: string;
  }> {
    if (tenureMonths === 0) return []; // OD/CC: no fixed schedule

    const r = rateAnnual / 12 / 100;
    const rows = [];
    let opening = principalPaise;
    let currentDate = new Date(repaymentStartDate);

    for (let i = 0; i < tenureMonths; i++) {
      const month = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
      const interestComponent = Math.round(opening * r);
      const isLastMonth = i === tenureMonths - 1;
      // Last EMI: principal = remaining outstanding (avoids rounding drift)
      const principalComponent = isLastMonth
        ? opening
        : Math.min(emiAmountPaise - interestComponent, opening);
      const actualEmi = principalComponent + interestComponent;
      const closing = opening - principalComponent;

      rows.push({
        workspaceId,
        firmId,
        loanAccountId,
        month,
        openingPrincipalPaise: opening,
        emiAmountPaise: actualEmi,
        principalComponentPaise: principalComponent,
        interestComponentPaise: interestComponent,
        closingPrincipalPaise: closing,
        status: 'pending',
      });

      // Advance to next month
      const next = new Date(currentDate);
      next.setMonth(next.getMonth() + 1);
      currentDate = next;
      opening = closing;
    }

    return rows;
  }

  // ─── Create ───────────────────────────────────────────────────────────────

  async create(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    dto: CreateLoanAccountDto,
    userId: string,
  ): Promise<LoanAccount> {
    return withFinanceSpan(
      this.tracer,
      'finance.createLoanAccount',
      { workspaceId: String(workspaceId), firmId: String(firmId), userId },
      async () => {
        const wsId = workspaceId.toString();
        const fId = firmId.toString();
        const firm = await this.firmsService.findOne(wsId, fId);
        const fyStart = (firm as any).fyStartMonth ?? 4;

        // Generate loan code: LN/YYYY-YY/NNNN via VoucherSeries
        const disbursementDate = new Date(dto.disbursementDate);
        const financialYear = this.voucherSeriesService.getFYForDate(disbursementDate, fyStart);
        const loanCode = await this.voucherSeriesService.generateNextNumber(
          fId,
          'loan_account',
          financialYear,
        );

        const emiAmountPaise = this.computeEmi(
          dto.disbursedAmountPaise,
          dto.interestRateAnnual,
          dto.tenureMonths,
        );

        const repaymentStartDate = new Date(dto.repaymentStartDate);
        const firstEmiMonth = `${repaymentStartDate.getFullYear()}-${String(repaymentStartDate.getMonth() + 1).padStart(2, '0')}`;

        const session = await this.conn.startSession();
        try {
          let savedLoan: LoanAccount;

          await session.withTransaction(async () => {
            const loanDoc = new this.loanModel({
              workspaceId,
              firmId,
              loanCode,
              name: dto.name,
              lenderName: dto.lenderName,
              lenderPartyId: dto.lenderPartyId ? new Types.ObjectId(dto.lenderPartyId) : undefined,
              loanType: dto.loanType,
              sanctionedAmountPaise: dto.sanctionedAmountPaise,
              disbursedAmountPaise: dto.disbursedAmountPaise,
              disbursementDate,
              interestRateAnnual: dto.interestRateAnnual,
              tenureMonths: dto.tenureMonths,
              repaymentStartDate,
              emiAmountPaise,
              processingFeePaise: dto.processingFeePaise,
              coaLiabilityAccountId: new Types.ObjectId(dto.coaLiabilityAccountId),
              coaLiabilityAccountCode: dto.coaLiabilityAccountCode,
              principalOutstandingPaise: dto.disbursedAmountPaise,
              totalInterestPaidPaise: 0,
              nextEmiMonth: dto.tenureMonths > 0 ? firstEmiMonth : undefined,
              status: 'active',
              auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'created' }],
            });

            savedLoan = await loanDoc.save({ session });

            // Generate and insert amortisation schedule (for term loans)
            if (dto.tenureMonths > 0) {
              const scheduleRows = this.generateSchedule(
                workspaceId,
                firmId,
                savedLoan._id,
                dto.disbursedAmountPaise,
                dto.interestRateAnnual,
                emiAmountPaise,
                dto.tenureMonths,
                repaymentStartDate,
              );
              if (scheduleRows.length > 0) {
                await this.scheduleModel.insertMany(scheduleRows, { session });
              }
            }
          });

          // Fire-and-forget product analytics on the successful create (ids/amount/type only;
          // lender name intentionally NOT logged per PII rule).
          this.postHog.capture({
            distinctId: userId,
            event: 'banking.created_loan_account',
            properties: {
              workspaceId: wsId,
              firmId: fId,
              loanAccountId: String(savedLoan._id),
              loanType: dto.loanType,
              sanctionedAmountPaise: dto.sanctionedAmountPaise,
              disbursedAmountPaise: dto.disbursedAmountPaise,
              tenureMonths: dto.tenureMonths,
            },
          });
          return savedLoan;
        } finally {
          await session.endSession();
        }
      },
    );
  }

  // ─── List / FindById ──────────────────────────────────────────────────────

  async findAll(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    filters: ListLoanAccountsDto,
  ): Promise<LoanAccount[]> {
    const query: Record<string, any> = { workspaceId, firmId, isDeleted: false };
    if (filters.status) query.status = filters.status;
    if (filters.loanType) query.loanType = filters.loanType;
    return this.loanModel.find(query).sort({ createdAt: -1 }).exec();
  }

  async findById(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
  ): Promise<LoanAccount> {
    const doc = await this.loanModel
      .findOne({ _id: new Types.ObjectId(id), workspaceId, firmId, isDeleted: false })
      .exec();
    if (!doc) throw new NotFoundException(`LoanAccount ${id} not found`);
    return doc;
  }

  async getSchedule(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    loanId: string,
  ): Promise<LoanScheduleEntry[]> {
    return this.scheduleModel
      .find({ workspaceId, firmId, loanAccountId: new Types.ObjectId(loanId) })
      .sort({ month: 1 })
      .exec();
  }

  // ─── Record disbursement ──────────────────────────────────────────────────

  /**
   * Post the loan disbursement journal entry.
   * Dr bankCoaCode / Cr coaLiabilityAccountCode
   */
  async recordDisbursement(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    loanId: string,
    dto: RecordDisbursementDto,
    userId: string,
  ): Promise<LoanAccount> {
    return withFinanceSpan(
      this.tracer,
      'finance.recordLoanDisbursement',
      { workspaceId: String(workspaceId), firmId: String(firmId), userId },
      async () => {
        const loan = await this.findById(workspaceId, firmId, loanId);
        const wsId = workspaceId.toString();
        const fId = firmId.toString();
        const firm = await this.firmsService.findOne(wsId, fId);
        const fyStart = (firm as any).fyStartMonth ?? 4;
        const disbDate = new Date(dto.disbursementDate);
        const fy = this.voucherSeriesService.getFYForDate(disbDate, fyStart);

        await this.ledgerPostingService.postLoanDisbursement(
          {
            loanAccountId: loan._id,
            loanCode: loan.loanCode,
            workspaceId,
            firmId,
            financialYear: fy,
            disbursementDate: disbDate,
            disbursedAmountPaise: dto.amountPaise,
            bankCoaCode: dto.bankCoaCode,
            loanLiabilityCode: loan.coaLiabilityAccountCode,
            narration: dto.narration,
          },
          { userId },
        );

        loan.auditLog.push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'disbursement_posted',
          amountPaise: dto.amountPaise,
        });

        const saved = await (loan as any).save();
        // Fire-and-forget product analytics on the successful disbursement (ids/amount only).
        this.postHog.capture({
          distinctId: userId,
          event: 'banking.disbursed_loan',
          properties: {
            workspaceId: wsId,
            firmId: fId,
            loanAccountId: loanId,
            amountPaise: dto.amountPaise,
          },
        });
        return saved;
      },
    );
  }

  // ─── Close loan ───────────────────────────────────────────────────────────

  async close(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    loanId: string,
    closureType: 'foreclosure' | 'full_repayment',
    userId: string,
  ): Promise<LoanAccount> {
    return withFinanceSpan(
      this.tracer,
      'finance.closeLoanAccount',
      { workspaceId: String(workspaceId), firmId: String(firmId), userId },
      async () => {
        const loan = await this.findById(workspaceId, firmId, loanId);
        if (loan.status !== 'active') {
          throw new BadRequestException(`Loan is already ${loan.status}`);
        }

        loan.status = 'closed';
        loan.closureDate = new Date();
        loan.closureType = closureType;
        loan.auditLog.push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'closed',
          closureType,
        });
        const saved = await (loan as any).save();
        // Fire-and-forget product analytics on the successful close (ids/type only).
        this.postHog.capture({
          distinctId: userId,
          event: 'banking.closed_loan_account',
          properties: {
            workspaceId: String(workspaceId),
            firmId: String(firmId),
            loanAccountId: loanId,
            closureType,
          },
        });
        return saved;
      },
    );
  }

  // ─── Mark NPA ─────────────────────────────────────────────────────────────

  async markNpa(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    loanId: string,
    userId: string,
  ): Promise<LoanAccount> {
    return withFinanceSpan(
      this.tracer,
      'finance.markLoanNpa',
      { workspaceId: String(workspaceId), firmId: String(firmId), userId },
      async () => {
        const loan = await this.findById(workspaceId, firmId, loanId);
        if (loan.status !== 'active') {
          throw new BadRequestException(`Loan is ${loan.status} — cannot mark NPA`);
        }

        loan.status = 'npa';
        loan.auditLog.push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'marked_npa',
        });
        const saved = await (loan as any).save();
        // Fire-and-forget product analytics on the successful NPA marking (ids only).
        this.postHog.capture({
          distinctId: userId,
          event: 'banking.marked_loan_npa',
          properties: {
            workspaceId: String(workspaceId),
            firmId: String(firmId),
            loanAccountId: loanId,
          },
        });
        return saved;
      },
    );
  }

  // ─── Run EMI for a single loan + month ───────────────────────────────────

  /**
   * Post the EMI entry for a specific loan + month.
   *
   * Idempotency:
   *   1. Upsert LoanEmiRun (firmId, loanAccountId, runMonth) with status=running.
   *      If already completed → skip (idempotent).
   *      If already running → another process is handling it (skip).
   *   2. Find LoanScheduleEntry for the month → get principal/interest split.
   *   3. Post LedgerEntry via postLoanEmi (sourceVoucherId = scheduleEntry._id).
   *   4. $inc principalOutstandingPaise on LoanAccount.
   *   5. Advance nextEmiMonth cursor.
   *   6. Mark LoanEmiRun completed.
   *
   * Bank CoA code defaults to '1002' (generic bank) if the loan has no bankCoaCode.
   * Loans created with specific bank accounts should store bankCoaCode — for now
   * we use the firm's default bank CoA code ('1002').
   */
  async runEmiForMonth(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    loanId: string,
    runMonth: string, // YYYY-MM
    bankCoaCode: string,
    userId: string,
  ): Promise<{ skipped: boolean; reason?: string }> {
    return withFinanceSpan(
      this.tracer,
      'finance.runLoanEmi',
      { workspaceId: String(workspaceId), firmId: String(firmId), userId, runMonth },
      async () => {
        const loan = await this.findById(workspaceId, firmId, loanId);
        if (loan.status !== 'active') {
          return { skipped: true, reason: `Loan status is ${loan.status}` };
        }

        // Idempotency guard — upsert LoanEmiRun
        const emiRun = await this.emiRunModel.findOneAndUpdate(
          { firmId, loanAccountId: loan._id, runMonth },
          {
            $setOnInsert: {
              workspaceId,
              firmId,
              loanAccountId: loan._id,
              runMonth,
              status: 'running',
              runAt: new Date(),
            },
          },
          { upsert: true, new: false },
        );

        if (emiRun && (emiRun.status === 'completed' || emiRun.status === 'running')) {
          return { skipped: true, reason: `LoanEmiRun already ${emiRun.status}` };
        }

        // Find schedule entry for this month
        const scheduleEntry = await this.scheduleModel.findOne({
          workspaceId,
          firmId,
          loanAccountId: loan._id,
          month: runMonth,
        });

        if (!scheduleEntry) {
          await this.emiRunModel.updateOne(
            { firmId, loanAccountId: loan._id, runMonth },
            { status: 'failed' },
          );
          return { skipped: true, reason: `No schedule entry for ${runMonth}` };
        }

        if (scheduleEntry.status === 'paid') {
          await this.emiRunModel.updateOne(
            { firmId, loanAccountId: loan._id, runMonth },
            { status: 'completed' },
          );
          return { skipped: true, reason: 'Already paid' };
        }

        const wsId = workspaceId.toString();
        const fId = firmId.toString();
        const firm = await this.firmsService.findOne(wsId, fId);
        const fyStart = (firm as any).fyStartMonth ?? 4;
        const emiDate = new Date();
        const fy = this.voucherSeriesService.getFYForDate(emiDate, fyStart);

        const session = await this.conn.startSession();
        try {
          await session.withTransaction(async () => {
            // Post the EMI ledger entry
            const ledgerEntry = await this.ledgerPostingService.postLoanEmi(
              {
                scheduleEntryId: scheduleEntry._id,
                loanCode: loan.loanCode,
                month: runMonth,
                workspaceId,
                firmId,
                financialYear: fy,
                emiDate,
                emiAmountPaise: scheduleEntry.emiAmountPaise,
                principalComponentPaise: scheduleEntry.principalComponentPaise,
                interestComponentPaise: scheduleEntry.interestComponentPaise,
                bankCoaCode,
                loanLiabilityCode: loan.coaLiabilityAccountCode,
              },
              { session, userId },
            );

            // Update schedule entry: paid
            await this.scheduleModel.updateOne(
              { _id: scheduleEntry._id },
              {
                status: 'paid',
                paidOn: emiDate,
                ledgerEntryId: ledgerEntry._id,
              },
              { session },
            );

            // Decrement outstanding principal
            await this.loanModel.updateOne(
              { _id: loan._id },
              {
                $inc: {
                  principalOutstandingPaise: -scheduleEntry.principalComponentPaise,
                  totalInterestPaidPaise: scheduleEntry.interestComponentPaise,
                },
              },
              { session },
            );

            // Advance nextEmiMonth cursor to next month
            const [yearStr, monthStr] = runMonth.split('-');
            const nextDate = new Date(parseInt(yearStr), parseInt(monthStr) - 1 + 1, 1);
            const nextMonth = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}`;

            // Check if next month has a schedule entry — if not, this was the last EMI
            const nextSchedule = await this.scheduleModel.findOne(
              { loanAccountId: loan._id, month: nextMonth },
              null,
              { session },
            );
            const newNextEmiMonth = nextSchedule ? nextMonth : undefined;
            const shouldClose = !nextSchedule && loan.loanType === 'term_loan';

            await this.loanModel.updateOne(
              { _id: loan._id },
              {
                $set: {
                  lastEmiMonth: runMonth,
                  nextEmiMonth: newNextEmiMonth,
                  ...(shouldClose
                    ? { status: 'closed', closureDate: emiDate, closureType: 'full_repayment' }
                    : {}),
                },
              },
              { session },
            );

            // Mark EMI run completed
            await this.emiRunModel.updateOne(
              { firmId, loanAccountId: loan._id, runMonth },
              { status: 'completed', ledgerEntryId: ledgerEntry._id, runAt: emiDate },
              { session },
            );
          });

          // Fire-and-forget product analytics on the successful EMI post (ids/amount only).
          this.postHog.capture({
            distinctId: userId,
            event: 'banking.posted_loan_emi',
            properties: {
              workspaceId: String(workspaceId),
              firmId: String(firmId),
              loanAccountId: loanId,
              runMonth,
              emiAmountPaise: scheduleEntry.emiAmountPaise,
            },
          });

          return { skipped: false };
        } catch (err) {
          // Mark run failed so cron can retry next cycle
          await this.emiRunModel.updateOne(
            { firmId, loanAccountId: loan._id, runMonth },
            { status: 'failed' },
          );
          throw err;
        } finally {
          await session.endSession();
        }
      },
    );
  }

  // ─── runEmiForCurrentMonth: manual trigger for current month ─────────────

  /**
   * Convenience wrapper: post EMI for the current calendar month.
   * Same logic as the cron — exposed via POST /:id/run-emi for manual triggers.
   * Idempotent: returns { skipped: true } if EMI already posted this month.
   */
  async runEmiForCurrentMonth(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    loanId: string,
    bankCoaCode: string,
    userId: string,
  ): Promise<{ skipped: boolean; reason?: string }> {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return this.runEmiForMonth(workspaceId, firmId, loanId, month, bankCoaCode, userId);
  }

  // ─── Prepayment ───────────────────────────────────────────────────────────

  /**
   * Record a loan prepayment.
   *
   * Flow:
   *   1. Validate amountPaise <= principalOutstandingPaise (T-F06W5-06)
   *   2. Post ledger: Dr loanLiabilityCode / Cr bankCoaCode
   *   3. Reduce principalOutstandingPaise on LoanAccount
   *   4. Mark all pending schedule entries as 'prepaid'
   *   5. Recompute new schedule using LoanScheduleService.recomputeAfterPrepayment
   *      (strategy: preserve EMI, shorten tenure)
   *   6. Insert new schedule rows replacing the prepaid pending ones
   *   7. Update nextEmiMonth cursor from new schedule
   *
   * Security: workspaceId + firmId scoped; amount validated.
   */
  async prepay(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    loanId: string,
    dto: PrepayLoanDto,
    userId: string,
  ): Promise<LoanAccount> {
    return withFinanceSpan(
      this.tracer,
      'finance.prepayLoan',
      { workspaceId: String(workspaceId), firmId: String(firmId), userId },
      async () => {
        const loan = await this.findById(workspaceId, firmId, loanId);

        if (loan.status !== 'active') {
          throw new BadRequestException(`Loan is ${loan.status} — cannot prepay`);
        }
        if (loan.loanType !== 'term_loan') {
          throw new BadRequestException('Prepayment only applies to term loans');
        }

        // T-F06W5-06: prepayment must not exceed outstanding principal
        if (dto.amountPaise > loan.principalOutstandingPaise) {
          throw new BadRequestException(
            `Prepayment amount (${dto.amountPaise} paise) exceeds outstanding principal (${loan.principalOutstandingPaise} paise)`,
          );
        }

        const wsId = workspaceId.toString();
        const fId = firmId.toString();
        const firm = await this.firmsService.findOne(wsId, fId);
        const fyStart = (firm as any).fyStartMonth ?? 4;
        const prepayDate = new Date(dto.prepaymentDate);
        const fy = this.voucherSeriesService.getFYForDate(prepayDate, fyStart);

        const session = await this.conn.startSession();
        try {
          let updatedLoan: LoanAccount;

          await session.withTransaction(async () => {
            // 1. Post prepayment ledger entry: Dr loanLiability / Cr bank
            await this.ledgerPostingService.postLoanDisbursement(
              {
                loanAccountId: loan._id,
                loanCode: loan.loanCode,
                workspaceId,
                firmId,
                financialYear: fy,
                disbursementDate: prepayDate,
                disbursedAmountPaise: dto.amountPaise,
                // Reversed: Dr loanLiability / Cr bank (use postContraEntry semantics)
                bankCoaCode: loan.coaLiabilityAccountCode, // Dr liability
                loanLiabilityCode: dto.bankCoaCode, // Cr bank
                narration:
                  dto.narration ??
                  `Prepayment of ${dto.amountPaise / 100} for loan ${loan.loanCode}`,
              },
              { session, userId },
            );

            // 2. Find all pending schedule entries for this loan
            const pendingEntries = await this.scheduleModel
              .find({
                workspaceId,
                firmId,
                loanAccountId: loan._id,
                status: 'pending',
              })
              .sort({ month: 1 })
              .session(session)
              .exec();

            // 3. Mark pending entries as 'prepaid'
            if (pendingEntries.length > 0) {
              await this.scheduleModel.updateMany(
                {
                  workspaceId,
                  firmId,
                  loanAccountId: loan._id,
                  status: 'pending',
                },
                { status: 'prepaid' },
                { session },
              );
            }

            // 4. Compute new remaining principal after prepayment
            const newPrincipal = loan.principalOutstandingPaise - dto.amountPaise;

            // 5. Recompute schedule with preserved EMI and shortened tenure
            const nextPendingMonth = pendingEntries.length > 0 ? pendingEntries[0].month : null;

            if (newPrincipal > 0 && nextPendingMonth) {
              const newRows = this.loanScheduleService.recomputeAfterPrepayment(
                newPrincipal,
                loan.emiAmountPaise,
                loan.interestRateAnnual,
                nextPendingMonth,
              );

              // 6. Insert new schedule rows
              if (newRows.length > 0) {
                const scheduleDocs = newRows.map((r) => ({
                  workspaceId,
                  firmId,
                  loanAccountId: loan._id,
                  month: r.month,
                  openingPrincipalPaise: r.openingPrincipalPaise,
                  emiAmountPaise: r.emiAmountPaise,
                  principalComponentPaise: r.principalComponentPaise,
                  interestComponentPaise: r.interestComponentPaise,
                  closingPrincipalPaise: r.closingPrincipalPaise,
                  status: 'pending',
                }));
                await this.scheduleModel.insertMany(scheduleDocs, { session });
              }

              // 7. Update LoanAccount: reduce outstanding, update cursor
              const newNextEmiMonth = newRows.length > 0 ? newRows[0].month : undefined;
              await this.loanModel.updateOne(
                { _id: loan._id },
                {
                  $set: {
                    principalOutstandingPaise: newPrincipal,
                    nextEmiMonth: newNextEmiMonth,
                  },
                  $push: {
                    auditLog: {
                      at: new Date(),
                      by: new Types.ObjectId(userId),
                      action: 'prepayment',
                      amountPaise: dto.amountPaise,
                    },
                  },
                },
                { session },
              );
            } else {
              // Prepayment fully repays the loan — close it
              await this.loanModel.updateOne(
                { _id: loan._id },
                {
                  $set: {
                    principalOutstandingPaise: 0,
                    nextEmiMonth: undefined,
                    status: 'closed',
                    closureDate: prepayDate,
                    closureType: 'foreclosure',
                  },
                  $push: {
                    auditLog: {
                      at: new Date(),
                      by: new Types.ObjectId(userId),
                      action: 'prepayment_full_closure',
                      amountPaise: dto.amountPaise,
                    },
                  },
                },
                { session },
              );
            }

            updatedLoan = (await this.loanModel
              .findById(loan._id)
              .session(session)
              .exec()) as LoanAccount;
          });

          // Fire-and-forget product analytics on the successful prepayment (ids/amount only).
          this.postHog.capture({
            distinctId: userId,
            event: 'banking.prepaid_loan',
            properties: {
              workspaceId: String(workspaceId),
              firmId: String(firmId),
              loanAccountId: loanId,
              amountPaise: dto.amountPaise,
            },
          });

          return updatedLoan;
        } finally {
          await session.endSession();
        }
      },
    );
  }

  // ─── Soft delete ──────────────────────────────────────────────────────────

  /**
   * Soft-delete a loan account.
   * Only allowed if no LoanScheduleEntry has been paid (no EMIs posted).
   */
  async softDelete(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    loanId: string,
    userId: string,
  ): Promise<void> {
    return withFinanceSpan(
      this.tracer,
      'finance.deleteLoanAccount',
      { workspaceId: String(workspaceId), firmId: String(firmId), userId },
      async () => {
        const loan = await this.findById(workspaceId, firmId, loanId);

        // Block deletion if any EMI has been posted
        const paidCount = await this.scheduleModel.countDocuments({
          workspaceId,
          firmId,
          loanAccountId: loan._id,
          status: 'paid',
        });

        if (paidCount > 0) {
          throw new BadRequestException(
            `Cannot delete loan ${loan.loanCode} — ${paidCount} EMI(s) already posted`,
          );
        }

        await this.loanModel.updateOne(
          { _id: loan._id },
          {
            $set: { isDeleted: true },
            $push: {
              auditLog: { at: new Date(), by: new Types.ObjectId(userId), action: 'deleted' },
            },
          },
        );
        // Fire-and-forget product analytics on the successful soft-delete (ids only).
        this.postHog.capture({
          distinctId: userId,
          event: 'banking.deleted_loan_account',
          properties: {
            workspaceId: String(workspaceId),
            firmId: String(firmId),
            loanAccountId: loanId,
          },
        });
      },
    );
  }

  // ─── Cron: process all due EMIs for a given month ─────────────────────────

  /**
   * Called by the monthly EMI cron (LoanEmiCronService).
   * Finds all active term loans where nextEmiMonth <= runMonth and posts their EMI.
   *
   * @param runMonth   YYYY-MM string for the month to process
   * @param bankCoaCode  Default bank CoA code for EMI debit (e.g. '1002')
   */
  async processEmiForMonth(runMonth: string, bankCoaCode = '1002'): Promise<void> {
    return withFinanceSpan(this.tracer, 'finance.processEmiForMonth', { runMonth }, async () => {
      const dueLoans = await this.loanModel
        .find({
          status: 'active',
          loanType: 'term_loan',
          nextEmiMonth: { $lte: runMonth },
        })
        .exec();

      for (const loan of dueLoans) {
        try {
          await this.runEmiForMonth(
            loan.workspaceId,
            loan.firmId,
            loan._id.toString(),
            runMonth,
            bankCoaCode,
            'cron',
          );
        } catch (err) {
          // Log failure and continue — don't block other loans
          console.error(
            `[LoanEmiCron] Failed to post EMI for loan ${loan.loanCode} / ${runMonth}:`,
            err,
          );
        }
      }
    });
  }

  // ─── Preview Schedule (stateless) ─────────────────────────────────────────

  /**
   * Compute a preview amortisation schedule without persisting anything.
   * Used by the web LoanForm's AmortisationPreviewCard for live EMI estimation.
   *
   * Delegates to LoanScheduleService.computeSchedule (pure stateless function).
   */
  previewSchedule(dto: PreviewScheduleDto): ScheduleRow[] {
    return this.loanScheduleService.computeSchedule({
      sanctionedAmountPaise: dto.sanctionedAmountPaise,
      interestRateAnnual: dto.interestRateAnnual,
      tenureMonths: dto.tenureMonths,
      repaymentStartDate: new Date(dto.repaymentStartDate),
    });
  }
}
