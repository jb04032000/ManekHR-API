import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Connection, Model, Types } from 'mongoose';
import { withFinanceSpan } from '../common/finance-observability';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { JournalVoucher } from './journal-voucher.schema';
import { Account } from '../ledger/account.schema';
import { VoucherSeriesService } from '../voucher-series/voucher-series.service';
import { LedgerPostingService } from '../sales/ledger-posting/ledger-posting.service';
import { FirmsService } from '../firms/firms.service';
import { CreateJournalVoucherDto, JournalVoucherLineDto } from './dto/create-journal-voucher.dto';
import { ListJournalVouchersDto } from './dto/list-journal-vouchers.dto';
import { FyLockService } from '../fiscal-year/fy-lock.service';

@Injectable()
export class JournalVouchersService {
  constructor(
    @InjectModel(JournalVoucher.name)
    private readonly model: Model<JournalVoucher>,
    @InjectModel(Account.name)
    private readonly accountModel: Model<Account>,
    @InjectConnection()
    private readonly conn: Connection,
    private readonly voucherSeriesService: VoucherSeriesService,
    private readonly ledgerPostingService: LedgerPostingService,
    @Inject(forwardRef(() => FirmsService))
    private readonly firmsService: any,
    private readonly fyLock: FyLockService,
    private readonly postHog: PostHogService,
  ) {}

  // Platform-bar observability: shared finance tracer. Spans wrap each write;
  // PostHog fires fire-and-forget after a successful write.
  private readonly tracer = trace.getTracer('finance');

  /**
   * Resolve an account by ObjectId, scoped to workspace+firm for cross-firm safety.
   * T-F06W3-07: every account lookup is firm-scoped.
   */
  private async resolveAccountById(
    wsId: string,
    firmId: string,
    accountId: string,
  ): Promise<Account> {
    const doc = await this.accountModel
      .findOne({
        _id: new Types.ObjectId(accountId),
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .exec();
    if (!doc) throw new NotFoundException(`Account ${accountId} not found`);
    return doc;
  }

  /**
   * Validates that all JV lines are balanced (sum debits === sum credits).
   * Each line must have exactly one of debit or credit > 0 (not both, not neither).
   * T-F06W3-01: dual-layer balance enforcement
   */
  private validateBalanced(lines: JournalVoucherLineDto[]): {
    totalDebitPaise: number;
    totalCreditPaise: number;
  } {
    let totalDebit = 0;
    let totalCredit = 0;
    for (const l of lines) {
      // Defense-in-depth: the DTO already enforces @Min(0), but validateBalanced is
      // also reachable by internal (non-DTO) callers, so reject negative amounts here
      // too - a negative would invert the Dr/Cr balance semantics.
      if (l.debitPaise < 0 || l.creditPaise < 0) {
        throw new BadRequestException('Line amounts cannot be negative');
      }
      if (l.debitPaise > 0 && l.creditPaise > 0) {
        throw new BadRequestException('Each line must have only debit OR credit, not both');
      }
      if (l.debitPaise === 0 && l.creditPaise === 0) {
        throw new BadRequestException('Line cannot have both debit and credit zero');
      }
      totalDebit += l.debitPaise;
      totalCredit += l.creditPaise;
    }
    if (totalDebit !== totalCredit) {
      throw new BadRequestException(`JV not balanced: Dr ${totalDebit} ≠ Cr ${totalCredit}`);
    }
    return { totalDebitPaise: totalDebit, totalCreditPaise: totalCredit };
  }

  /**
   * Create a draft JournalVoucher.
   * Validates balance, enriches lines with account snapshots, derives FY.
   */
  async create(
    wsId: string,
    firmId: string,
    dto: CreateJournalVoucherDto,
    userId: string,
  ): Promise<JournalVoucher> {
    return withFinanceSpan(
      this.tracer,
      'finance.createJournalVoucher',
      { workspaceId: wsId, firmId, userId },
      async () => {
        // F-15 Plan 03: FY-lock guard
        await this.fyLock.assertOpen(wsId, firmId, new Date(dto.voucherDate));

        const totals = this.validateBalanced(dto.lines);

        // Contra vouchers must have exactly 2 lines (T-F06W3-03 via ContraService; structural guard)
        if (dto.voucherType === 'contra' && dto.lines.length !== 2) {
          throw new BadRequestException('Contra voucher must have exactly 2 lines (1 Dr, 1 Cr)');
        }

        // Resolve each line.accountId -> snapshot accountCode + accountName (T-F06W3-07: firm-scoped lookup)
        const enrichedLines: any[] = [];
        for (const l of dto.lines) {
          const acct = await this.resolveAccountById(wsId, firmId, l.accountId);
          enrichedLines.push({
            accountId: (acct as any)._id,
            accountCode: (acct as any).code,
            accountName: (acct as any).name,
            debitPaise: l.debitPaise,
            creditPaise: l.creditPaise,
            partyId: l.partyId ? new Types.ObjectId(l.partyId) : undefined,
            costCentre: l.costCentre,
          });
        }

        // Derive financial year from voucherDate (same pattern as ExpensesService)
        const firm = await this.firmsService.findOne(wsId, firmId);
        const voucherDate = new Date(dto.voucherDate);
        const financialYear = this.voucherSeriesService.getFYForDate(
          voucherDate,
          firm.fyStartMonth ?? 4,
        );

        const doc = new this.model({
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          voucherType: dto.voucherType,
          voucherDate,
          financialYear,
          state: 'draft',
          narration: dto.narration,
          lines: enrichedLines,
          totalDebitPaise: totals.totalDebitPaise,
          totalCreditPaise: totals.totalCreditPaise,
          reference: dto.reference,
          isRecurring: dto.isRecurring || false,
          recurringConfig: dto.recurringConfig,
          createdBy: new Types.ObjectId(userId),
          auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'create' }],
        });

        const saved = await doc.save();
        // Fire-and-forget product analytics on the successful draft write (ids/amount only).
        // Contra vouchers funnel through here too — distinguish via voucherType.
        this.postHog.capture({
          distinctId: userId,
          event:
            dto.voucherType === 'contra'
              ? 'banking.created_contra'
              : 'banking.created_journal_voucher',
          properties: {
            workspaceId: wsId,
            firmId,
            journalVoucherId: String(saved._id),
            voucherType: dto.voucherType,
            totalDebitPaise: totals.totalDebitPaise,
            lineCount: dto.lines.length,
          },
        });
        return saved;
      },
    );
  }

  /**
   * Post a draft JournalVoucher - allocates voucher number, posts LedgerEntry.
   * Runs in a transaction for atomicity.
   */
  async post(
    wsId: string,
    firmId: string,
    voucherId: string,
    userId: string,
  ): Promise<JournalVoucher> {
    return withFinanceSpan(
      this.tracer,
      'finance.postJournalVoucher',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const session = await this.conn.startSession();
        try {
          const posted = await session.withTransaction(async () => {
            const v = await this.model
              .findOne({
                workspaceId: new Types.ObjectId(wsId),
                firmId: new Types.ObjectId(firmId),
                _id: new Types.ObjectId(voucherId),
              })
              .session(session)
              .exec();

            if (!v) throw new NotFoundException('JournalVoucher not found');
            if (v.state !== 'draft') {
              throw new BadRequestException('Only draft vouchers can be posted');
            }

            // F-15 Plan 03: FY-lock guard
            await this.fyLock.assertOpen(wsId, firmId, v.voucherDate);

            // Fetch firm for FY context and posting opts
            const firm = await this.firmsService.findOne(wsId, firmId);

            // Allocate voucher number (VoucherSeriesService.generateNextNumber throws if series missing;
            // 'contra' series is seeded in seedDefaults - Wave 1 enum extension covers it)
            v.voucherNumber = await this.voucherSeriesService.generateNextNumber(
              firmId,
              v.voucherType,
              v.financialYear,
            );
            v.state = 'posted';
            v.auditLog.push({
              at: new Date(),
              by: new Types.ObjectId(userId),
              action: 'post',
            });
            await (v as any).save({ session });

            // Post LedgerEntry (postJournalVoucher sets entryType='journal' or 'contra')
            await this.ledgerPostingService.postJournalVoucher(v, {
              session,
              userId,
              firm: firm,
            });

            return v;
          });
          // Fire-and-forget product analytics on the successful post (ids/voucher no only).
          this.postHog.capture({
            distinctId: userId,
            event:
              posted?.voucherType === 'contra'
                ? 'banking.posted_contra'
                : 'banking.posted_journal_voucher',
            properties: {
              workspaceId: wsId,
              firmId,
              journalVoucherId: voucherId,
              voucherNumber: posted?.voucherNumber,
              voucherType: posted?.voucherType,
            },
          });
          return posted;
        } finally {
          await session.endSession();
        }
      },
    );
  }

  /**
   * Cancel a posted JournalVoucher - posts reversal LedgerEntry, marks original isReversed.
   */
  async cancel(
    wsId: string,
    firmId: string,
    voucherId: string,
    userId: string,
    reason?: string,
  ): Promise<JournalVoucher> {
    return withFinanceSpan(
      this.tracer,
      'finance.cancelJournalVoucher',
      { workspaceId: wsId, firmId, userId },
      async () => {
        const session = await this.conn.startSession();
        try {
          const cancelled = await session.withTransaction(async () => {
            const v = await this.model
              .findOne({
                workspaceId: new Types.ObjectId(wsId),
                firmId: new Types.ObjectId(firmId),
                _id: new Types.ObjectId(voucherId),
              })
              .session(session)
              .exec();

            if (!v) throw new NotFoundException('JournalVoucher not found');
            if (v.state !== 'posted') {
              throw new BadRequestException('Only posted vouchers can be cancelled');
            }

            // F-15 Plan 03: FY-lock guard
            await this.fyLock.assertOpen(wsId, firmId, v.voucherDate);

            // Load original LedgerEntry by sourceVoucherId (finds journal or contra entry)
            const originalEntry = await this.ledgerPostingService.findJournalEntry(
              new Types.ObjectId(voucherId),
              session,
            );
            if (!originalEntry) {
              throw new NotFoundException('Original ledger entry not found');
            }

            const firm = await this.firmsService.findOne(wsId, firmId);

            // Post reversal with sourceVoucherType='journal_reversal' (distinct unique key per T-F06W3-01)
            await this.ledgerPostingService.postJournalReversal(v, originalEntry, {
              session,
              userId,
              firm: firm,
            });

            // Mark original entry as reversed
            await this.ledgerPostingService.markEntryReversed(
              (originalEntry as any)._id as Types.ObjectId,
              session,
            );

            v.state = 'cancelled';
            v.auditLog.push({
              at: new Date(),
              by: new Types.ObjectId(userId),
              action: 'cancel',
              reason,
            });
            await (v as any).save({ session });

            return v;
          });
          // Fire-and-forget product analytics on the successful cancel (ids/voucher no only).
          this.postHog.capture({
            distinctId: userId,
            event:
              cancelled?.voucherType === 'contra'
                ? 'banking.cancelled_contra'
                : 'banking.cancelled_journal_voucher',
            properties: {
              workspaceId: wsId,
              firmId,
              journalVoucherId: voucherId,
              voucherNumber: cancelled?.voucherNumber,
              voucherType: cancelled?.voucherType,
            },
          });
          return cancelled;
        } finally {
          await session.endSession();
        }
      },
    );
  }

  async list(
    wsId: string,
    firmId: string,
    filters: ListJournalVouchersDto,
  ): Promise<{ items: JournalVoucher[]; total: number }> {
    // T-F06W3-07: workspace + firm mandatory in every query
    const filter: Record<string, any> = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
    };

    if (filters.state) filter.state = filters.state;
    if (filters.voucherType) filter.voucherType = filters.voucherType;
    if (filters.dateFrom || filters.dateTo) {
      filter.voucherDate = {};
      if (filters.dateFrom) filter.voucherDate.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) filter.voucherDate.$lte = new Date(filters.dateTo);
    }

    const limit = filters.limit ?? 25;
    const skip = ((filters.page ?? 1) - 1) * limit;

    const [items, total] = await Promise.all([
      this.model.find(filter).sort({ voucherDate: -1 }).skip(skip).limit(limit).exec(),
      this.model.countDocuments(filter).exec(),
    ]);

    return { items, total };
  }

  async findById(wsId: string, firmId: string, voucherId: string): Promise<JournalVoucher> {
    // T-F06W3-07: workspace + firm mandatory
    const doc = await this.model
      .findOne({
        _id: new Types.ObjectId(voucherId),
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
      })
      .exec();
    if (!doc) throw new NotFoundException('JournalVoucher not found');
    return doc;
  }
}
