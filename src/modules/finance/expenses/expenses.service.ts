import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Connection, Model, Types } from 'mongoose';
import { ExpenseVoucher } from './expense-voucher.schema';
import { Account } from '../ledger/account.schema';
import { VoucherSeriesService } from '../voucher-series/voucher-series.service';
import { LedgerPostingService } from '../sales/ledger-posting/ledger-posting.service';
import { TdsService } from '../purchases/tds/tds.service';
import { CashRegistersService } from '../cash-registers/cash-registers.service';
import { FirmsService } from '../firms/firms.service';
import { CreateExpenseVoucherDto } from './dto/create-expense-voucher.dto';
import { UpdateExpenseVoucherDto } from './dto/update-expense-voucher.dto';
import { ListExpenseVouchersDto } from './dto/list-expense-vouchers.dto';
import { isBlockedItcAccount } from './blocked-itc-accounts';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../common/finance-observability';

@Injectable()
export class ExpensesService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(ExpenseVoucher.name)
    private readonly model: Model<ExpenseVoucher>,
    @InjectModel(Account.name)
    private readonly accountModel: Model<Account>,
    @InjectConnection()
    private readonly conn: Connection,
    private readonly voucherSeriesService: VoucherSeriesService,
    private readonly ledgerPostingService: LedgerPostingService,
    private readonly tdsService: TdsService,
    private readonly cashRegistersService: CashRegistersService,
    private readonly firmsService: FirmsService,
    private readonly postHog: PostHogService,
  ) {}

  /** Resolve account by ObjectId, scoped to workspace+firm for cross-firm safety */
  private async resolveAccount(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    accountId: string,
  ): Promise<Account> {
    const account = await this.accountModel
      .findOne({
        _id: new Types.ObjectId(accountId),
        workspaceId,
        firmId,
        isDeleted: false,
      })
      .exec();
    if (!account) throw new NotFoundException(`Account ${accountId} not found`);
    return account;
  }

  async create(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    dto: CreateExpenseVoucherDto,
    userId: string,
  ): Promise<ExpenseVoucher> {
    return withFinanceSpan(
      this.tracer,
      'finance.createExpense',
      { workspaceId: workspaceId.toString(), firmId: firmId.toString(), userId },
      async () => {
        const wsId = workspaceId.toString();
        const fId = firmId.toString();

        // Compute line-level GST amounts and apply blocked-ITC enforcement
        const processedLines: any[] = [];
        for (const line of dto.lineItems) {
          // Resolve account to snapshot code+name and check blocked-ITC (T-F06W2-01)
          const account = await this.resolveAccount(workspaceId, firmId, line.expenseAccountId);
          const accountCode: string = (account as any).code ?? '';
          const accountName: string = (account as any).name ?? '';

          // Server-side blocked-ITC override (T-F06W2-01)
          let itcEligibility = line.itcEligibility;
          if (isBlockedItcAccount(accountCode, accountName)) {
            itcEligibility = 'blocked';
          }

          // Compute GST paise server-side; client values discarded (T-F06W2-03)
          const gstRate = line.gstRate ?? 0;
          let cgstPaise = 0;
          let sgstPaise = 0;
          let igstPaise = 0;

          if (gstRate > 0) {
            if (dto.isIntraState) {
              cgstPaise = Math.round((line.amountPaise * (gstRate / 2)) / 100);
              sgstPaise = Math.round((line.amountPaise * (gstRate / 2)) / 100);
            } else {
              igstPaise = Math.round((line.amountPaise * gstRate) / 100);
            }
          }

          const lineTotalPaise = line.amountPaise + cgstPaise + sgstPaise + igstPaise;

          processedLines.push({
            expenseAccountId: new Types.ObjectId(line.expenseAccountId),
            expenseAccountCode: accountCode,
            expenseAccountName: accountName,
            description: line.description,
            amountPaise: line.amountPaise,
            gstRate: line.gstRate,
            cgstPaise,
            sgstPaise,
            igstPaise,
            itcEligibility,
            lineTotalPaise,
            costCentre: line.costCentre,
          });
        }

        // Compute voucher-level aggregates
        const taxableValuePaise = processedLines.reduce((s, l) => s + l.amountPaise, 0);
        const totalGstPaise = processedLines.reduce(
          (s, l) => s + (l.cgstPaise ?? 0) + (l.sgstPaise ?? 0) + (l.igstPaise ?? 0),
          0,
        );
        const grandTotalPaise = taxableValuePaise + totalGstPaise;
        const totalItcEligiblePaise = processedLines
          .filter((l) => l.itcEligibility === 'full')
          .reduce((s, l) => s + (l.cgstPaise ?? 0) + (l.sgstPaise ?? 0) + (l.igstPaise ?? 0), 0);
        const totalItcBlockedPaise = totalGstPaise - totalItcEligiblePaise;

        // Derive financial year from voucherDate
        const firm = await this.firmsService.findOne(wsId, fId);
        const voucherDate = new Date(dto.voucherDate);
        const financialYear = this.voucherSeriesService.getFYForDate(
          voucherDate,
          (firm as any).fyStartMonth ?? 4,
        );

        const doc = new this.model({
          workspaceId,
          firmId,
          voucherType: 'expense',
          voucherDate,
          financialYear,
          state: 'draft',
          partyId: dto.partyId ? new Types.ObjectId(dto.partyId) : undefined,
          paymentMode: dto.paymentMode,
          cashRegisterId: dto.cashRegisterId ? new Types.ObjectId(dto.cashRegisterId) : undefined,
          bankAccountId: dto.bankAccountId ? new Types.ObjectId(dto.bankAccountId) : undefined,
          chequeId: dto.chequeId ? new Types.ObjectId(dto.chequeId) : undefined,
          utrReference: dto.utrReference,
          isIntraState: dto.isIntraState,
          placeOfSupplyStateCode: dto.placeOfSupplyStateCode,
          narration: dto.narration,
          lineItems: processedLines,
          taxableValuePaise,
          totalGstPaise,
          grandTotalPaise,
          totalItcEligiblePaise,
          totalItcBlockedPaise,
          netPayablePaise: grandTotalPaise, // updated at post time after TDS
          createdBy: new Types.ObjectId(userId),
          auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'created' }],
        });

        const saved = await doc.save();
        // Fire-and-forget product analytics on the successful draft write (ids only, no PII).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.created_expense',
          properties: { workspaceId: wsId, firmId: fId, expenseId: String(saved._id) },
        });
        return saved;
      },
    );
  }

  async post(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    voucherId: Types.ObjectId,
    userId: string,
  ): Promise<ExpenseVoucher> {
    return withFinanceSpan(
      this.tracer,
      'finance.postExpense',
      { workspaceId: workspaceId.toString(), firmId: firmId.toString(), userId },
      async () => {
        const wsId = workspaceId.toString();
        const fId = firmId.toString();

        const session = await this.conn.startSession();
        try {
          const posted = await session.withTransaction(async () => {
            const voucher = await this.model
              .findOne({ workspaceId, firmId, _id: voucherId })
              .session(session)
              .exec();
            if (!voucher) throw new NotFoundException('ExpenseVoucher not found');
            if (voucher.state !== 'draft') {
              throw new BadRequestException('Only draft vouchers can be posted');
            }

            // 1. Allocate voucher number
            voucher.voucherNumber = await this.voucherSeriesService.generateNextNumber(
              fId,
              'expense',
              voucher.financialYear,
            );

            // 2. TDS apply (if party snapshot has supplierType) — T-F06W2-02/T-F06W2-04
            // TDS rate is resolved server-side; client cannot pass tdsApplied
            if (voucher.partyId && (voucher.partySnapshot as any)?.supplierType) {
              const tdsResult = await this.tdsService.computeAtPaymentOut(
                workspaceId,
                firmId,
                {
                  _id: voucher.partyId,
                  supplierType: (voucher.partySnapshot as any)?.supplierType,
                  deducteeStatus: (voucher.partySnapshot as any)?.deducteeStatus,
                  pan: (voucher.partySnapshot as any)?.pan,
                },
                voucher.taxableValuePaise,
                voucher.financialYear,
                session,
              );
              if (tdsResult && tdsResult.tdsPaise > 0) {
                voucher.tdsApplied = {
                  section: tdsResult.section as any,
                  rate: tdsResult.rate,
                  basePaise: tdsResult.basePaise,
                  tdsPaise: tdsResult.tdsPaise,
                };
                voucher.netPayablePaise = voucher.grandTotalPaise - tdsResult.tdsPaise;
              } else {
                voucher.netPayablePaise = voucher.grandTotalPaise;
              }
            } else {
              voucher.netPayablePaise = voucher.grandTotalPaise;
            }

            // 3. Cash register: atomic decrement with insufficient-cash guard (T-F06W2-05)
            if (voucher.paymentMode === 'cash') {
              if (!voucher.cashRegisterId) {
                throw new BadRequestException('cashRegisterId required when paymentMode=cash');
              }
              const reg = await this.cashRegistersService.atomicDecrement(
                voucher.cashRegisterId,
                voucher.netPayablePaise,
                session,
              );
              if (!reg) {
                throw new BadRequestException('Insufficient cash in register');
              }
            }

            // 4. State change and audit log (T-F06W2-06)
            voucher.state = 'posted';
            voucher.auditLog.push({
              at: new Date(),
              by: new Types.ObjectId(userId),
              action: 'post',
            });
            await (voucher as any).save({ session });

            // 5. Post LedgerEntry
            const firm = await this.firmsService.findOne(wsId, fId);
            await this.ledgerPostingService.postExpenseVoucher(voucher, {
              session,
              userId,
              firm: firm as any,
            });

            return voucher;
          });
          // Fire-and-forget product analytics on the successful post (ids / voucher no only).
          // withTransaction returns the committed voucher; mongoose may type it as void,
          // so cast for the analytics payload only (does not alter the returned value).
          this.postHog?.capture({
            distinctId: userId,
            event: 'purchases.posted_expense',
            properties: {
              workspaceId: wsId,
              firmId: fId,
              expenseId: String((posted as any)?._id),
              voucherNumber: (posted as any)?.voucherNumber,
            },
          });
          return posted as ExpenseVoucher;
        } finally {
          await session.endSession();
        }
      },
    );
  }

  async cancel(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    voucherId: Types.ObjectId,
    userId: string,
    reason?: string,
  ): Promise<ExpenseVoucher> {
    return withFinanceSpan(
      this.tracer,
      'finance.cancelExpense',
      { workspaceId: workspaceId.toString(), firmId: firmId.toString(), userId },
      async () => {
        const session = await this.conn.startSession();
        try {
          const cancelled = await session.withTransaction(async () => {
            const voucher = await this.model
              .findOne({ workspaceId, firmId, _id: voucherId })
              .session(session)
              .exec();
            if (!voucher) throw new NotFoundException('ExpenseVoucher not found');
            if (voucher.state !== 'posted') {
              throw new BadRequestException('Only posted vouchers can be cancelled');
            }

            // Load original LedgerEntry (sourceVoucherType='expense')
            const originalEntry = await this.ledgerPostingService.findExpenseEntry(
              voucherId,
              session,
            );
            if (!originalEntry) {
              throw new NotFoundException('Original ledger entry not found');
            }

            // Fetch firm for posting context
            const firm = await this.firmsService.findOne(workspaceId.toString(), firmId.toString());

            // Post reversal LedgerEntry with distinct sourceVoucherType (T-F06W2-08)
            await this.ledgerPostingService.postExpenseReversal(voucher, originalEntry, {
              session,
              userId,
              firm: firm as any,
            });

            // Mark original LedgerEntry as reversed (T-F06W2-06)
            await this.ledgerPostingService.markEntryReversed(originalEntry._id, session);

            // Refund cash register if payment was via cash
            if (voucher.paymentMode === 'cash' && voucher.cashRegisterId) {
              await this.cashRegistersService.atomicIncrement(
                voucher.cashRegisterId,
                voucher.netPayablePaise,
                session,
              );
            }

            // Update voucher state with cancel audit entry (T-F06W2-06)
            voucher.state = 'cancelled';
            voucher.auditLog.push({
              at: new Date(),
              by: new Types.ObjectId(userId),
              action: 'cancel',
              reason,
            });
            await (voucher as any).save({ session });

            return voucher;
          });
          // Fire-and-forget product analytics on the successful cancel (ids only).
          this.postHog?.capture({
            distinctId: userId,
            event: 'purchases.cancelled_expense',
            properties: {
              workspaceId: workspaceId.toString(),
              firmId: firmId.toString(),
              expenseId: String((cancelled as any)?._id),
            },
          });
          return cancelled as ExpenseVoucher;
        } finally {
          await session.endSession();
        }
      },
    );
  }

  async list(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    filters: ListExpenseVouchersDto,
  ): Promise<{ items: ExpenseVoucher[]; total: number }> {
    // workspaceId+firmId mandatory — no cross-firm leakage (T-F06W2-07)
    const filter: Record<string, any> = { workspaceId, firmId };

    if (filters.state) filter.state = filters.state;
    if (filters.partyId) filter.partyId = new Types.ObjectId(filters.partyId);
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

  async findById(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    voucherId: Types.ObjectId,
  ): Promise<ExpenseVoucher> {
    // workspaceId+firmId scoped (T-F06W2-07)
    const doc = await this.model.findOne({ _id: voucherId, workspaceId, firmId }).exec();
    if (!doc) throw new NotFoundException('ExpenseVoucher not found');
    return doc;
  }

  async update(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    voucherId: Types.ObjectId,
    dto: UpdateExpenseVoucherDto,
    userId: string,
  ): Promise<ExpenseVoucher> {
    return withFinanceSpan(
      this.tracer,
      'finance.updateExpense',
      { workspaceId: workspaceId.toString(), firmId: firmId.toString(), userId },
      async () => {
        const voucher = await this.findById(workspaceId, firmId, voucherId);
        if (voucher.state !== 'draft') {
          throw new BadRequestException('Only draft vouchers can be updated');
        }

        // Whitelist mutable fields — prevent state/workspaceId/firmId injection
        const scalarFields = [
          'voucherDate',
          'partyId',
          'paymentMode',
          'cashRegisterId',
          'bankAccountId',
          'chequeId',
          'utrReference',
          'isIntraState',
          'placeOfSupplyStateCode',
          'narration',
        ] as const;

        for (const key of scalarFields) {
          if (key in dto && (dto as any)[key] !== undefined) {
            (voucher as any)[key] = (dto as any)[key];
          }
        }

        // Re-process lineItems if provided — server recomputes GST
        if (dto.lineItems && dto.lineItems.length > 0) {
          const processedLines: any[] = [];
          const isIntra = dto.isIntraState !== undefined ? dto.isIntraState : voucher.isIntraState;

          for (const line of dto.lineItems) {
            const account = await this.resolveAccount(workspaceId, firmId, line.expenseAccountId);
            const accountCode: string = (account as any).code ?? '';
            const accountName: string = (account as any).name ?? '';

            let itcEligibility = line.itcEligibility;
            if (isBlockedItcAccount(accountCode, accountName)) {
              itcEligibility = 'blocked';
            }

            const gstRate = line.gstRate ?? 0;
            let cgstPaise = 0;
            let sgstPaise = 0;
            let igstPaise = 0;

            if (gstRate > 0) {
              if (isIntra) {
                cgstPaise = Math.round((line.amountPaise * (gstRate / 2)) / 100);
                sgstPaise = Math.round((line.amountPaise * (gstRate / 2)) / 100);
              } else {
                igstPaise = Math.round((line.amountPaise * gstRate) / 100);
              }
            }

            const lineTotalPaise = line.amountPaise + cgstPaise + sgstPaise + igstPaise;

            processedLines.push({
              expenseAccountId: new Types.ObjectId(line.expenseAccountId),
              expenseAccountCode: accountCode,
              expenseAccountName: accountName,
              description: line.description,
              amountPaise: line.amountPaise,
              gstRate: line.gstRate,
              cgstPaise,
              sgstPaise,
              igstPaise,
              itcEligibility,
              lineTotalPaise,
              costCentre: line.costCentre,
            });
          }

          voucher.lineItems = processedLines;

          const taxableValuePaise = processedLines.reduce((s, l) => s + l.amountPaise, 0);
          const totalGstPaise = processedLines.reduce(
            (s, l) => s + (l.cgstPaise ?? 0) + (l.sgstPaise ?? 0) + (l.igstPaise ?? 0),
            0,
          );
          voucher.taxableValuePaise = taxableValuePaise;
          voucher.totalGstPaise = totalGstPaise;
          voucher.grandTotalPaise = taxableValuePaise + totalGstPaise;
          voucher.totalItcEligiblePaise = processedLines
            .filter((l) => l.itcEligibility === 'full')
            .reduce((s, l) => s + (l.cgstPaise ?? 0) + (l.sgstPaise ?? 0) + (l.igstPaise ?? 0), 0);
          voucher.totalItcBlockedPaise = voucher.totalGstPaise - voucher.totalItcEligiblePaise;
          voucher.netPayablePaise = voucher.grandTotalPaise;
        }

        voucher.auditLog.push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'updated',
        });

        const saved = await (voucher as any).save();
        // Fire-and-forget product analytics on the successful draft update (ids only).
        this.postHog?.capture({
          distinctId: userId,
          event: 'purchases.updated_expense',
          properties: {
            workspaceId: workspaceId.toString(),
            firmId: firmId.toString(),
            expenseId: String(saved._id),
          },
        });
        return saved;
      },
    );
  }
}
