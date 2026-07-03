import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { ClientSession, Model, Types } from 'mongoose';
import { withFinanceSpan } from '../common/finance-observability';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { CashRegister } from './cash-register.schema';
import { DayEndTallyDto } from './dto/day-end-tally.dto';
import { ReplenishPettyCashDto } from './dto/replenish-petty-cash.dto';
import { AccountsService } from '../ledger/accounts.service';
import { JournalVouchersService } from '../journal-vouchers/journal-vouchers.service';
import { ContraService } from '../journal-vouchers/contra.service';
import { JournalVoucher } from '../journal-vouchers/journal-voucher.schema';

@Injectable()
export class CashRegistersService {
  // Platform-bar observability: shared finance tracer + PostHog. Spans wrap each
  // write; PostHog fires fire-and-forget after a successful write that carries a userId.
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(CashRegister.name)
    private readonly model: Model<CashRegister>,
    private readonly accountsService: AccountsService,
    private readonly journalVouchersService: JournalVouchersService,
    private readonly contraService: ContraService,
    private readonly postHog: PostHogService,
  ) {}

  async create(workspaceId: string, firmId: string, dto: any): Promise<CashRegister> {
    return withFinanceSpan(
      this.tracer,
      'finance.createCashRegister',
      { workspaceId, firmId },
      async () => {
        const doc = new this.model({
          ...dto,
          workspaceId: new Types.ObjectId(workspaceId),
          firmId: new Types.ObjectId(firmId),
        });
        return doc.save();
      },
    );
  }

  async seedDefault(workspaceId: string, firmId: string): Promise<void> {
    const wsId = new Types.ObjectId(workspaceId);
    const fId = new Types.ObjectId(firmId);
    await this.model.updateOne(
      { workspaceId: wsId, firmId: fId, isDefault: true },
      {
        $setOnInsert: {
          workspaceId: wsId,
          firmId: fId,
          name: 'Main Cash',
          type: 'main',
          isDefault: true,
          currentBalance: 0,
          isDeleted: false,
        },
      },
      { upsert: true },
    );
  }

  async findAll(workspaceId: string, firmId: string): Promise<CashRegister[]> {
    return this.model
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .exec();
  }

  async findOne(workspaceId: string, firmId: string, id: string): Promise<CashRegister> {
    const doc = await this.model
      .findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .exec();
    if (!doc) throw new NotFoundException('CashRegister not found');
    return doc;
  }

  async update(workspaceId: string, firmId: string, id: string, dto: any): Promise<CashRegister> {
    return withFinanceSpan(
      this.tracer,
      'finance.updateCashRegister',
      { workspaceId, firmId },
      async () => {
        const doc = await this.model
          .findOneAndUpdate(
            {
              _id: new Types.ObjectId(id),
              workspaceId: new Types.ObjectId(workspaceId),
              firmId: new Types.ObjectId(firmId),
              isDeleted: false,
            },
            { $set: dto },
            { new: true },
          )
          .exec();
        if (!doc) throw new NotFoundException('CashRegister not found');
        return doc;
      },
    );
  }

  /**
   * Atomically decrements cash register balance (used for expense/payment cash outflows).
   * Uses $inc with a currentBalance >= amount guard — atomic check-and-decrement.
   * Returns null if the register is not found or has insufficient balance.
   * NOTE: currentBalance is stored in rupees (divide paise by 100).
   */
  async atomicDecrement(
    registerId: Types.ObjectId,
    amountPaise: number,
    session?: ClientSession,
  ): Promise<CashRegister | null> {
    const amountRupees = amountPaise / 100;
    return this.model.findOneAndUpdate(
      {
        _id: registerId,
        currentBalance: { $gte: amountRupees },
        isDeleted: { $ne: true },
      },
      { $inc: { currentBalance: -amountRupees } },
      { new: true, session },
    );
  }

  /**
   * Atomically increments cash register balance (used for refunds / reversal of cash expenses).
   */
  async atomicIncrement(
    registerId: Types.ObjectId,
    amountPaise: number,
    session?: ClientSession,
  ): Promise<CashRegister | null> {
    const amountRupees = amountPaise / 100;
    return this.model.findOneAndUpdate(
      { _id: registerId, isDeleted: { $ne: true } },
      { $inc: { currentBalance: amountRupees } },
      { new: true, session },
    );
  }

  async remove(workspaceId: string, firmId: string, id: string): Promise<void> {
    return withFinanceSpan(
      this.tracer,
      'finance.removeCashRegister',
      { workspaceId, firmId },
      async () => {
        const doc = await this.model
          .findOne({
            _id: new Types.ObjectId(id),
            workspaceId: new Types.ObjectId(workspaceId),
            firmId: new Types.ObjectId(firmId),
          })
          .exec();
        if (!doc) throw new NotFoundException('CashRegister not found');
        if (doc.isDefault) throw new ForbiddenException('Cannot delete the default cash register');
        await this.model
          .updateOne({ _id: doc._id }, { isDeleted: true, deletedAt: new Date() })
          .exec();
      },
    );
  }

  // ─── Day-end denomination tally ──────────────────────────────────────────────

  /**
   * Performs a day-end cash tally:
   * 1. Computes physical total from denomination breakdown
   * 2. Compares to system currentBalance (rupees)
   * 3. If variance != 0: posts a JV:
   *    - Shortage (physical < system): Dr 5011 Misc Expense / Cr 1001 Cash
   *    - Surplus  (physical > system): Dr 1001 Cash / Cr 4002 Other Income
   * 4. Updates register: denominationBreakdown, lastTallyAt, currentBalance (T-F06W3-04)
   *
   * T-F06W3-05: concurrent tally detection via lastTallyAt — 409 if within 1 minute
   */
  async dayEndTally(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    registerId: Types.ObjectId,
    dto: DayEndTallyDto,
    userId: string,
  ): Promise<{ register: CashRegister; varianceJv?: JournalVoucher }> {
    return withFinanceSpan(
      this.tracer,
      'finance.dayEndTally',
      { workspaceId: String(workspaceId), firmId: String(firmId), userId },
      async () => {
        const wsId = workspaceId.toString();
        const fId = firmId.toString();

        const reg = await this.model
          .findOne({
            workspaceId,
            firmId,
            _id: registerId,
            isDeleted: { $ne: true },
          })
          .exec();
        if (!reg) throw new NotFoundException('CashRegister not found');

        // T-F06W3-05: concurrent tally guard — reject if last tally was less than 1 minute ago
        if (reg.lastTallyAt) {
          const elapsedMs = Date.now() - reg.lastTallyAt.getTime();
          if (elapsedMs < 60_000) {
            throw new BadRequestException(
              'A tally was already performed within the last minute — please wait before retrying',
            );
          }
        }

        // Compute physical total in rupees from denomination breakdown
        const physicalTotalRupees = dto.denominationBreakdown.reduce(
          (sum, d) => sum + d.denomination * d.count,
          0,
        );
        const systemBalanceRupees = reg.currentBalance; // rupees per schema convention
        const differenceRupees = physicalTotalRupees - systemBalanceRupees;
        const differencePaise = Math.round(differenceRupees * 100);

        let varianceJv: JournalVoucher | undefined;

        if (Math.abs(differencePaise) > 0) {
          // Resolve CoA accounts for shortage/surplus journal
          const cashAcct = await this.accountsService.findByCode(wsId, fId, '1001');
          const expAcct = await this.accountsService.findByCode(wsId, fId, '5011'); // Misc Expense
          const incAcct = await this.accountsService.findByCode(wsId, fId, '4002'); // Other Income

          const isShortage = differencePaise < 0;
          const absPaise = Math.abs(differencePaise);
          const tallyDate = new Date().toISOString().slice(0, 10);

          const lines = isShortage
            ? [
                // Shortage: Dr Misc Expense / Cr Cash
                {
                  accountId: (expAcct as any)._id.toString(),
                  debitPaise: absPaise,
                  creditPaise: 0,
                },
                {
                  accountId: (cashAcct as any)._id.toString(),
                  debitPaise: 0,
                  creditPaise: absPaise,
                },
              ]
            : [
                // Surplus: Dr Cash / Cr Other Income
                {
                  accountId: (cashAcct as any)._id.toString(),
                  debitPaise: absPaise,
                  creditPaise: 0,
                },
                {
                  accountId: (incAcct as any)._id.toString(),
                  debitPaise: 0,
                  creditPaise: absPaise,
                },
              ];

          // Create and post variance JV (auditable — T-F06W3-04)
          const draft = await this.journalVouchersService.create(
            wsId,
            fId,
            {
              voucherDate: new Date().toISOString(),
              voucherType: 'journal',
              narration: `Cash Tally ${isShortage ? 'Shortage' : 'Surplus'} on ${tallyDate} for register ${reg.name}`,
              lines,
            },
            userId,
          );
          varianceJv = await this.journalVouchersService.post(
            wsId,
            fId,
            (draft as any)._id.toString(),
            userId,
          );

          // Adjust register balance to physical total (books now match physical)
          reg.currentBalance = physicalTotalRupees;
        }

        // Persist denomination snapshot and tally timestamp (T-F06W3-04)
        reg.denominationBreakdown = dto.denominationBreakdown;
        reg.lastTallyAt = new Date();
        await (reg as any).save();

        // Fire-and-forget product analytics on the successful tally (ids/variance only, no PII).
        this.postHog.capture({
          distinctId: userId,
          event: 'banking.day_end_tallied_cash_register',
          properties: {
            workspaceId: wsId,
            firmId: fId,
            registerId: String(registerId),
            variancePaise: differencePaise,
            varianceJvPosted: Boolean(varianceJv),
          },
        });

        return { register: reg, varianceJv };
      },
    );
  }

  // ─── Petty cash replenishment ─────────────────────────────────────────────────

  /**
   * Replenishes a petty cash register from a source account (main cash or bank).
   * Creates a contra voucher: Dr 1001 Cash (petty register) / Cr sourceAccountCode.
   * Increments the petty cash register's balance via ContraService (toCashRegisterId).
   */
  async replenishPettyCash(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    registerId: Types.ObjectId,
    dto: ReplenishPettyCashDto,
    userId: string,
  ): Promise<JournalVoucher> {
    return withFinanceSpan(
      this.tracer,
      'finance.replenishPettyCash',
      { workspaceId: String(workspaceId), firmId: String(firmId), userId },
      async () => {
        const wsId = workspaceId.toString();
        const fId = firmId.toString();

        const reg = await this.model
          .findOne({
            workspaceId,
            firmId,
            _id: registerId,
            isDeleted: { $ne: true },
          })
          .exec();
        if (!reg) throw new NotFoundException('CashRegister not found');
        if (reg.type !== 'petty_cash') {
          throw new BadRequestException('Replenishment is only for petty cash registers');
        }

        // ContraService handles: source register decrement + destination register increment + JV create+post
        const jv = await this.contraService.createAndPost(
          wsId,
          fId,
          {
            voucherDate: new Date().toISOString(),
            fromAccountCode: dto.sourceAccountCode,
            toAccountCode: '1001', // Cash CoA code — petty cash draws from general cash
            amountPaise: dto.amountPaise,
            narration: dto.narration,
            fromCashRegisterId: dto.sourceCashRegisterId, // optional: decrement source register
            toCashRegisterId: registerId.toString(), // increment THIS petty cash register
          },
          userId,
        );
        // Fire-and-forget product analytics on the successful replenishment (ids/amount only).
        this.postHog.capture({
          distinctId: userId,
          event: 'banking.replenished_petty_cash',
          properties: {
            workspaceId: wsId,
            firmId: fId,
            registerId: String(registerId),
            amountPaise: dto.amountPaise,
          },
        });
        return jv;
      },
    );
  }

  // ─── Low-water alert ──────────────────────────────────────────────────────────

  /**
   * Returns petty cash registers where currentBalance (rupees) * 100 < lowWaterThresholdPaise.
   * Used by Wave 6 UI banner to prompt replenishment.
   */
  async lowWaterAlert(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
  ): Promise<CashRegister[]> {
    return this.model
      .find({
        workspaceId,
        firmId,
        isDeleted: { $ne: true },
        type: 'petty_cash',
        lowWaterThresholdPaise: { $exists: true, $gt: 0 },
        $expr: {
          $lt: [{ $multiply: ['$currentBalance', 100] }, '$lowWaterThresholdPaise'],
        },
      })
      .exec();
  }
}
