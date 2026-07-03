import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Connection, Model, Types } from 'mongoose';
import { withFinanceSpan } from '../common/finance-observability';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { Cheque } from './cheque.schema';
import { BankAccountsService } from '../bank-accounts/bank-accounts.service';
import {
  LedgerPostingService,
  PostContraEntryOptions,
} from '../sales/ledger-posting/ledger-posting.service';
import { FirmsService } from '../firms/firms.service';
import { CreateChequeDto } from './dto/create-cheque.dto';
import { ListChequesDto } from './dto/list-cheques.dto';
import {
  DepositChequeDto,
  ClearChequeDto,
  BounceChequeDto,
  StopChequePaidDto,
} from './dto/cheque-action.dto';

/**
 * ChequesService — manages the full PDC (Post-Dated Cheque) lifecycle.
 *
 * PDC status flow for ISSUED cheques:
 *   pending_maturity → cleared | stopped | bounced | void
 *
 * PDC status flow for RECEIVED cheques:
 *   pending_maturity → in_transit (deposit) → cleared | bounced
 *
 * Ledger entries use CoA codes:
 *   Bank account: cheque.bankCoaCode (the sub-account code under group 1002)
 *   2015 = PDC Payable
 *   1009 = PDC Receivable
 *   5014 = Cheque Bounce Charges
 *
 * Security: all queries scoped by workspaceId + firmId.
 */
@Injectable()
export class ChequesService {
  // Platform-bar observability: shared finance tracer + PostHog. Spans wrap each
  // write; PostHog fires fire-and-forget after a successful write (ids/amount only, never
  // the raw cheque number — PII rule).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(Cheque.name)
    private readonly model: Model<Cheque>,
    @InjectConnection()
    private readonly conn: Connection,
    private readonly bankAccountsService: BankAccountsService,
    private readonly ledgerPostingService: LedgerPostingService,
    private readonly firmsService: FirmsService,
    private readonly postHog: PostHogService,
  ) {}

  // ─── Create ───────────────────────────────────────────────────────────────

  async create(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    dto: CreateChequeDto,
    userId: string,
  ): Promise<Cheque> {
    return withFinanceSpan(
      this.tracer,
      'finance.createCheque',
      { workspaceId: String(workspaceId), firmId: String(firmId), userId },
      async () => {
        // Validate amount is whole paise (T-F06W4)
        if (!Number.isInteger(dto.amount) || dto.amount <= 0) {
          throw new BadRequestException('amount must be a positive integer (whole paise)');
        }

        // Validate bank account exists and belongs to this firm; snapshot name + coaCode
        const bankAccount = await this.bankAccountsService.findByIdInternal(
          workspaceId,
          firmId,
          new Types.ObjectId(dto.bankAccountId),
        );

        const chequeDate = new Date(dto.chequeDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        chequeDate.setHours(0, 0, 0, 0);
        const isPostDated = chequeDate > today;

        const doc = new this.model({
          workspaceId,
          firmId,
          chequeType: dto.chequeType,
          chequeNumber: dto.chequeNumber,
          chequeDate,
          isPostDated,
          bankAccountId: new Types.ObjectId(dto.bankAccountId),
          bankAccountName: (bankAccount as any).name,
          amount: dto.amount,
          partyId: dto.partyId ? new Types.ObjectId(dto.partyId) : undefined,
          partyName: dto.partyName,
          paymentVoucherId: dto.paymentVoucherId
            ? new Types.ObjectId(dto.paymentVoucherId)
            : undefined,
          paymentVoucherNumber: dto.paymentVoucherNumber,
          narration: dto.narration,
          status: 'pending_maturity',
          ledgerEntryIds: [],
          isDeleted: false,
        });

        const saved = await doc.save();
        // Fire-and-forget product analytics on the successful register (ids/amount/type only;
        // raw cheque number intentionally NOT logged per PII rule).
        this.postHog.capture({
          distinctId: userId,
          event: 'banking.registered_cheque',
          properties: {
            workspaceId: String(workspaceId),
            firmId: String(firmId),
            chequeId: String(saved._id),
            chequeType: dto.chequeType,
            amountPaise: dto.amount,
            isPostDated,
          },
        });
        return saved;
      },
    );
  }

  // ─── List ─────────────────────────────────────────────────────────────────

  async list(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    filters: ListChequesDto,
  ): Promise<{ items: Cheque[]; total: number }> {
    const query: Record<string, any> = { workspaceId, firmId, isDeleted: false };

    if (filters.chequeType) query.chequeType = filters.chequeType;
    if (filters.status) query.status = filters.status;
    if (filters.dateFrom || filters.dateTo) {
      query.chequeDate = {};
      if (filters.dateFrom) query.chequeDate.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) query.chequeDate.$lte = new Date(filters.dateTo);
    }

    const limit = filters.limit ?? 25;
    const skip = ((filters.page ?? 1) - 1) * limit;

    const [items, total] = await Promise.all([
      this.model.find(query).sort({ chequeDate: -1 }).skip(skip).limit(limit).exec(),
      this.model.countDocuments(query).exec(),
    ]);

    return { items, total };
  }

  // ─── FindById ─────────────────────────────────────────────────────────────

  async findById(workspaceId: Types.ObjectId, firmId: Types.ObjectId, id: string): Promise<Cheque> {
    const doc = await this.model
      .findOne({ _id: new Types.ObjectId(id), workspaceId, firmId, isDeleted: false })
      .exec();
    if (!doc) throw new NotFoundException(`Cheque ${id} not found`);
    return doc;
  }

  // ─── Deposit (received cheque → in_transit) ───────────────────────────────

  /**
   * Mark a received cheque as deposited (in_transit).
   * Only valid for received cheques in pending_maturity status.
   * No ledger entry at deposit time — entry posts on clearing.
   */
  async deposit(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
    dto: DepositChequeDto,
    userId: string,
  ): Promise<Cheque> {
    return withFinanceSpan(
      this.tracer,
      'finance.depositCheque',
      { workspaceId: String(workspaceId), firmId: String(firmId), userId },
      async () => {
        const cheque = await this.findById(workspaceId, firmId, id);
        if (cheque.chequeType !== 'received') {
          throw new BadRequestException('Only received cheques can be deposited');
        }
        if (cheque.status !== 'pending_maturity') {
          throw new BadRequestException(
            `Cheque status is '${cheque.status}' — only pending_maturity cheques can be deposited`,
          );
        }

        cheque.status = 'in_transit';
        cheque.depositDate = new Date(dto.depositDate);
        const saved = await (cheque as any).save();
        // Fire-and-forget product analytics on the successful deposit (ids only, no PII).
        this.postHog.capture({
          distinctId: userId,
          event: 'banking.deposited_cheque',
          properties: {
            workspaceId: String(workspaceId),
            firmId: String(firmId),
            chequeId: id,
          },
        });
        return saved;
      },
    );
  }

  // ─── Clear (cheque → cleared, posts ledger entry) ────────────────────────

  /**
   * Mark a cheque as cleared and post the settlement ledger entry.
   *
   * Issued cheque clearing (CoA: bankCoaCode = cheque's bank account code):
   *   Dr 2015 PDC Payable   amountPaise
   *     Cr bankCoaCode      amountPaise
   *   (atomicDebit on bank account)
   *
   * Received cheque clearing (must be in_transit):
   *   Dr bankCoaCode        amountPaise
   *     Cr 1009 PDC Receivable  amountPaise
   *   (atomicCredit on bank account)
   *
   * postContraEntry(fromCode, toCode, amount, ...) posts:
   *   Dr toCode / Cr fromCode
   */
  async clear(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
    dto: ClearChequeDto,
    userId: string,
  ): Promise<Cheque> {
    return withFinanceSpan(
      this.tracer,
      'finance.clearCheque',
      { workspaceId: String(workspaceId), firmId: String(firmId), userId },
      async () => {
        const session = await this.conn.startSession();
        try {
          const cleared = await session.withTransaction(async () => {
            const cheque = await this.model
              .findOne({ _id: new Types.ObjectId(id), workspaceId, firmId })
              .session(session)
              .exec();
            if (!cheque) throw new NotFoundException(`Cheque ${id} not found`);

            if (cheque.chequeType === 'issued') {
              if (cheque.status !== 'pending_maturity') {
                throw new BadRequestException(
                  `Issued cheque status is '${cheque.status}' — expected pending_maturity`,
                );
              }
            } else {
              // received: must be in_transit
              if (cheque.status !== 'in_transit') {
                throw new BadRequestException(
                  `Received cheque status is '${cheque.status}' — expected in_transit`,
                );
              }
            }

            // Resolve bank account CoA code for ledger posting
            const bankAccount = await this.bankAccountsService.findByIdInternal(
              workspaceId,
              firmId,
              cheque.bankAccountId,
            );
            const bankCoaCode = (bankAccount as any).coaAccountCode as string;

            const firm = await this.firmsService.findOne(workspaceId.toString(), firmId.toString());
            const clearingDate = new Date(dto.clearingDate);
            const fyStart = (firm as any).fyStartMonth ?? 4;
            const fy = this.deriveFinancialYear(clearingDate, fyStart);

            let entryId: Types.ObjectId | undefined;

            if (cheque.chequeType === 'issued') {
              // Atomic debit — $gte guard prevents overdraft
              const debited = await this.bankAccountsService.atomicDebit(
                cheque.bankAccountId,
                cheque.amount,
                session,
                workspaceId,
                firmId,
              );
              if (!debited) {
                throw new BadRequestException('Insufficient bank balance to clear issued cheque');
              }

              // postContraEntry(fromCode, toCode, ...) → Dr toCode / Cr fromCode
              // Issued cheque: Dr 2015 PDC Payable / Cr bankCoaCode
              const entry = await this.ledgerPostingService.postContraEntry(
                bankCoaCode, // fromCode = Cr bank
                '2015', // toCode   = Dr PDC Payable
                cheque.amount,
                `Issued cheque cleared: ${cheque.chequeNumber} — ${cheque.partyName ?? 'party'}`,
                this.buildContraOpts(
                  workspaceId,
                  firmId,
                  cheque,
                  clearingDate,
                  fy,
                  userId,
                  session,
                ),
              );
              entryId = entry._id;
            } else {
              // Received cheque: Dr bankCoaCode / Cr 1009 PDC Receivable
              await this.bankAccountsService.atomicCredit(
                cheque.bankAccountId,
                cheque.amount,
                session,
                workspaceId,
                firmId,
              );

              // postContraEntry(fromCode, toCode, ...) → Dr toCode / Cr fromCode
              // Received cleared: Dr bankCoaCode / Cr 1009 PDC Receivable
              const entry = await this.ledgerPostingService.postContraEntry(
                '1009', // fromCode = Cr PDC Receivable
                bankCoaCode, // toCode   = Dr Bank
                cheque.amount,
                `Received cheque cleared: ${cheque.chequeNumber} — ${cheque.partyName ?? 'party'}`,
                this.buildContraOpts(
                  workspaceId,
                  firmId,
                  cheque,
                  clearingDate,
                  fy,
                  userId,
                  session,
                  '-CLR',
                ),
              );
              entryId = entry._id;
            }

            cheque.status = 'cleared';
            cheque.clearingDate = clearingDate;
            cheque.presentationDate = cheque.depositDate ?? clearingDate;
            if (entryId) {
              cheque.ledgerEntryIds.push(entryId);
            }

            return (cheque as any).save({ session });
          });
          // Fire-and-forget product analytics on the successful clear (ids/amount only, no PII).
          this.postHog.capture({
            distinctId: userId,
            event: 'banking.cleared_cheque',
            properties: {
              workspaceId: String(workspaceId),
              firmId: String(firmId),
              chequeId: id,
              chequeType: cleared?.chequeType,
              amountPaise: cleared?.amount,
            },
          });
          return cleared;
        } finally {
          await session.endSession();
        }
      },
    );
  }

  // ─── Bounce ───────────────────────────────────────────────────────────────

  /**
   * Mark a cheque as bounced.
   *
   * Issued cheque bounce: no bank movement to reverse (never cleared).
   *   If bounceChargesPaise > 0:
   *     Dr 5014 Cheque Bounce Charges / Cr bankCoaCode
   *
   * Received cheque bounce (in_transit → bounced):
   *   Reverse the credit: Dr 1009 PDC Receivable / Cr bankCoaCode
   *   If bounceChargesPaise > 0:
   *     Dr 5014 Bounce Charges / Cr bankCoaCode
   */
  async bounce(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
    dto: BounceChequeDto,
    userId: string,
  ): Promise<Cheque> {
    return withFinanceSpan(
      this.tracer,
      'finance.bounceCheque',
      { workspaceId: String(workspaceId), firmId: String(firmId), userId },
      async () => {
        const session = await this.conn.startSession();
        try {
          const bounced = await session.withTransaction(async () => {
            const cheque = await this.model
              .findOne({ _id: new Types.ObjectId(id), workspaceId, firmId })
              .session(session)
              .exec();
            if (!cheque) throw new NotFoundException(`Cheque ${id} not found`);

            const allowedStates =
              cheque.chequeType === 'issued'
                ? ['pending_maturity']
                : ['pending_maturity', 'in_transit'];
            if (!allowedStates.includes(cheque.status)) {
              throw new BadRequestException(
                `Cheque status is '${cheque.status}' — cannot bounce in this state`,
              );
            }

            const bankAccount = await this.bankAccountsService.findByIdInternal(
              workspaceId,
              firmId,
              cheque.bankAccountId,
            );
            const bankCoaCode = (bankAccount as any).coaAccountCode as string;

            const firm = await this.firmsService.findOne(workspaceId.toString(), firmId.toString());
            const bounceDate = new Date(dto.bounceDate);
            const fyStart = (firm as any).fyStartMonth ?? 4;
            const fy = this.deriveFinancialYear(bounceDate, fyStart);

            const entryIds: Types.ObjectId[] = [];

            // Received cheque was in_transit (bank credit was already applied):
            // reverse the credit — Dr 1009 PDC Receivable / Cr bankCoaCode
            if (cheque.chequeType === 'received' && cheque.status === 'in_transit') {
              await this.bankAccountsService.atomicDebit(
                cheque.bankAccountId,
                cheque.amount,
                session,
                workspaceId,
                firmId,
              );
              // Dr 1009 PDC Receivable / Cr bankCoaCode (reverse of the deposit clearing)
              // postContraEntry(fromCode, toCode) → Dr toCode / Cr fromCode
              // We want: Dr 1009 / Cr bank → fromCode=bankCoaCode, toCode='1009'
              const reversal = await this.ledgerPostingService.postContraEntry(
                bankCoaCode, // fromCode = Cr bank
                '1009', // toCode   = Dr PDC Receivable (re-debited on bounce)
                cheque.amount,
                `Received cheque bounced: ${cheque.chequeNumber} — ${cheque.partyName ?? 'party'}`,
                this.buildContraOpts(
                  workspaceId,
                  firmId,
                  cheque,
                  bounceDate,
                  fy,
                  userId,
                  session,
                  '-BOUNCE',
                ),
              );
              entryIds.push(reversal._id);
            }

            // Post bounce charges (Dr 5014 / Cr bankCoaCode) if any
            if (dto.bounceChargesPaise && dto.bounceChargesPaise > 0) {
              await this.bankAccountsService.atomicDebit(
                cheque.bankAccountId,
                dto.bounceChargesPaise,
                session,
                workspaceId,
                firmId,
              );
              // Dr 5014 Bounce Charges / Cr bank
              // fromCode=bankCoaCode, toCode='5014'
              const chargesEntry = await this.ledgerPostingService.postContraEntry(
                bankCoaCode, // fromCode = Cr bank
                '5014', // toCode   = Dr Bounce Charges
                dto.bounceChargesPaise,
                `Cheque bounce charges: ${cheque.chequeNumber}`,
                this.buildContraOpts(
                  workspaceId,
                  firmId,
                  cheque,
                  bounceDate,
                  fy,
                  userId,
                  session,
                  '-CHG',
                ),
              );
              entryIds.push(chargesEntry._id);
            }

            cheque.status = 'bounced';
            cheque.bounceDate = bounceDate;
            cheque.bounceReason = dto.bounceReason;
            cheque.bounceChargesPaise = dto.bounceChargesPaise ?? 0;
            if (entryIds.length > 0) {
              cheque.ledgerEntryIds.push(...entryIds);
            }

            return (cheque as any).save({ session });
          });
          // Fire-and-forget product analytics on the successful bounce (ids/amount only, no PII).
          this.postHog.capture({
            distinctId: userId,
            event: 'banking.bounced_cheque',
            properties: {
              workspaceId: String(workspaceId),
              firmId: String(firmId),
              chequeId: id,
              chequeType: bounced?.chequeType,
              amountPaise: bounced?.amount,
              bounceChargesPaise: dto.bounceChargesPaise ?? 0,
            },
          });
          return bounced;
        } finally {
          await session.endSession();
        }
      },
    );
  }

  // ─── Stop payment ─────────────────────────────────────────────────────────

  /**
   * Mark an issued cheque as stopped (stop payment instruction to bank).
   * Only issued cheques in pending_maturity can be stopped.
   * No ledger entry required.
   */
  async stop(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
    dto: StopChequePaidDto,
    userId: string,
  ): Promise<Cheque> {
    return withFinanceSpan(
      this.tracer,
      'finance.stopCheque',
      { workspaceId: String(workspaceId), firmId: String(firmId), userId },
      async () => {
        const cheque = await this.findById(workspaceId, firmId, id);
        if (cheque.chequeType !== 'issued') {
          throw new BadRequestException('Only issued cheques can have stop payment');
        }
        if (cheque.status !== 'pending_maturity') {
          throw new BadRequestException(
            `Cheque status is '${cheque.status}' — only pending_maturity issued cheques can be stopped`,
          );
        }

        cheque.status = 'stopped';
        cheque.stopPaymentDate = new Date(dto.stopPaymentDate);
        cheque.stopPaymentNarration = dto.stopPaymentNarration;
        const saved = await (cheque as any).save();
        // Fire-and-forget product analytics on the successful stop payment (ids only, no PII).
        this.postHog.capture({
          distinctId: userId,
          event: 'banking.stopped_cheque',
          properties: {
            workspaceId: String(workspaceId),
            firmId: String(firmId),
            chequeId: id,
          },
        });
        return saved;
      },
    );
  }

  // ─── Void ─────────────────────────────────────────────────────────────────

  /**
   * Void a cheque (data entry error correction).
   * Only pending_maturity cheques can be voided.
   */
  async void(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    id: string,
    userId: string,
  ): Promise<Cheque> {
    return withFinanceSpan(
      this.tracer,
      'finance.voidCheque',
      { workspaceId: String(workspaceId), firmId: String(firmId), userId },
      async () => {
        const cheque = await this.findById(workspaceId, firmId, id);
        if (cheque.status !== 'pending_maturity') {
          throw new BadRequestException(
            `Cheque status is '${cheque.status}' — only pending_maturity cheques can be voided`,
          );
        }

        cheque.status = 'void';
        const saved = await (cheque as any).save();
        // Fire-and-forget product analytics on the successful void (ids only, no PII).
        this.postHog.capture({
          distinctId: userId,
          event: 'banking.voided_cheque',
          properties: {
            workspaceId: String(workspaceId),
            firmId: String(firmId),
            chequeId: id,
          },
        });
        return saved;
      },
    );
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private deriveFinancialYear(date: Date, fyStartMonth: number): string {
    const month = date.getMonth() + 1; // 1-12
    const year = date.getFullYear();
    if (month >= fyStartMonth) {
      return `${year}-${String(year + 1).slice(-2)}`;
    } else {
      return `${year - 1}-${String(year).slice(-2)}`;
    }
  }

  /** Build PostContraEntryOptions for ledger posting calls */
  private buildContraOpts(
    workspaceId: Types.ObjectId,
    firmId: Types.ObjectId,
    cheque: Cheque,
    date: Date,
    financialYear: string,
    userId: string,
    session: any,
    voucherSuffix = '',
  ): PostContraEntryOptions {
    return {
      firm: { _id: firmId, workspaceId } as any,
      userId,
      session,
      voucherId: cheque._id,
      voucherNumber: cheque.chequeNumber + voucherSuffix,
      voucherDate: date,
      financialYear,
    };
  }
}
