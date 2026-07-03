import { BadRequestException, Inject, Injectable, forwardRef } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Connection, Types } from 'mongoose';
import { withFinanceSpan } from '../common/finance-observability';
import { AccountsService } from '../ledger/accounts.service';
import { CashRegistersService } from '../cash-registers/cash-registers.service';
import { JournalVouchersService } from './journal-vouchers.service';
import { JournalVoucher } from './journal-voucher.schema';
import { CreateContraVoucherDto } from './dto/create-contra-voucher.dto';
import { ListJournalVouchersDto } from './dto/list-journal-vouchers.dto';
import { FyLockService } from '../fiscal-year/fy-lock.service';

@Injectable()
export class ContraService {
  // Platform-bar observability: shared finance tracer. createAndPost gets a span
  // only — the underlying JournalVouchersService.create/post already emit the
  // banking.created_contra / banking.posted_contra PostHog events (no double-fire).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    private readonly journalVouchersService: JournalVouchersService,
    private readonly accountsService: AccountsService,
    @Inject(forwardRef(() => CashRegistersService))
    private readonly cashRegistersService: any,
    @InjectConnection()
    private readonly conn: Connection,
    private readonly fyLock: FyLockService,
  ) {}

  /**
   * Validates that an account is of cash-or-bank type.
   * Contra vouchers can only move funds between cash/bank/OD-CC accounts (T-F06W3-03).
   */
  private isCashOrBank(account: any): boolean {
    // Check by CoA code prefix (1001 = Cash family, 1002 = Bank family)
    if ((account.code ?? '').startsWith('1001') || (account.code ?? '').startsWith('1002')) {
      return true;
    }
    // Check by group + subGroup for current asset cash-bank accounts
    if (account.group === 'Current Assets' && account.subGroup === 'Cash & Bank') {
      return true;
    }
    // OD/CC facilities (Non-Current Liabilities > Long-term Debt) also allowed for bank overdraft transfers
    if (account.group === 'Non-Current Liabilities' && account.subGroup === 'Long-term Debt') {
      return true;
    }
    return false;
  }

  /**
   * Create-and-post a Contra voucher in a single call.
   *
   * Journal posted:
   *   Dr  toAccount   amountPaise
   *     Cr  fromAccount amountPaise
   *
   * Use cases:
   *   - Cash -> Bank: fromCode=1001, toCode=1002-XX
   *   - Bank -> Cash: fromCode=1002-XX, toCode=1001
   *   - Petty cash replenishment: fromCode=1001 (main cash register), toCode=1001 (petty cash register)
   *   - Inter-bank transfer: fromCode=1002-XX, toCode=1002-YY
   */
  async createAndPost(
    wsId: string,
    firmId: string,
    dto: CreateContraVoucherDto,
    userId: string,
  ): Promise<JournalVoucher> {
    return withFinanceSpan(
      this.tracer,
      'finance.createAndPostContra',
      { workspaceId: wsId, firmId, userId },
      async () => {
        // F-15 Plan 03: FY-lock guard
        await this.fyLock.assertOpen(wsId, firmId, new Date(dto.voucherDate));

        // Resolve both accounts (T-F06W3-06: must belong to same firm + workspace)
        const fromAcct = await this.accountsService.findByCode(wsId, firmId, dto.fromAccountCode);
        const toAcct = await this.accountsService.findByCode(wsId, firmId, dto.toAccountCode);

        if (!fromAcct) {
          throw new BadRequestException(`Source account code ${dto.fromAccountCode} not found`);
        }
        if (!toAcct) {
          throw new BadRequestException(`Destination account code ${dto.toAccountCode} not found`);
        }

        // T-F06W3-03: both accounts must be cash or bank type
        if (!this.isCashOrBank(fromAcct)) {
          throw new BadRequestException(
            `Source account ${dto.fromAccountCode} is not a Cash or Bank account — contra transfer not allowed`,
          );
        }
        if (!this.isCashOrBank(toAcct)) {
          throw new BadRequestException(
            `Destination account ${dto.toAccountCode} is not a Cash or Bank account — contra transfer not allowed`,
          );
        }

        const session = await this.conn.startSession();
        try {
          return await session.withTransaction(async () => {
            // Build a 2-line JV with voucherType='contra': Dr toAccount / Cr fromAccount
            const draft = await this.journalVouchersService.create(
              wsId,
              firmId,
              {
                voucherDate: dto.voucherDate,
                voucherType: 'contra',
                narration: dto.narration,
                lines: [
                  {
                    accountId: (toAcct as any)._id.toString(),
                    debitPaise: dto.amountPaise,
                    creditPaise: 0,
                  },
                  {
                    accountId: (fromAcct as any)._id.toString(),
                    debitPaise: 0,
                    creditPaise: dto.amountPaise,
                  },
                ],
              },
              userId,
            );

            // Decrement source cash register if applicable (T-F06W3-05: atomic findOneAndUpdate)
            if (dto.fromCashRegisterId) {
              const reg = await this.cashRegistersService.atomicDecrement(
                new Types.ObjectId(dto.fromCashRegisterId),
                dto.amountPaise,
                session,
              );
              if (!reg) {
                throw new BadRequestException('Insufficient cash in source register');
              }
            }

            // Increment destination cash register if applicable
            if (dto.toCashRegisterId) {
              await this.cashRegistersService.atomicIncrement(
                new Types.ObjectId(dto.toCashRegisterId),
                dto.amountPaise,
                session,
              );
            }

            // Post the JV (uses postJournalVoucher which sets entryType='contra' for voucherType='contra')
            return this.journalVouchersService.post(
              wsId,
              firmId,
              (draft as any)._id.toString(),
              userId,
            );
          });
        } finally {
          await session.endSession();
        }
      },
    );
  }

  /**
   * List contra vouchers — filters JournalVouchers where voucherType='contra'.
   */
  async list(
    wsId: string,
    firmId: string,
    filters: Omit<ListJournalVouchersDto, 'voucherType'>,
  ): Promise<{ items: JournalVoucher[]; total: number }> {
    return this.journalVouchersService.list(wsId, firmId, {
      ...filters,
      voucherType: 'contra',
    });
  }

  async findById(wsId: string, firmId: string, voucherId: string): Promise<JournalVoucher> {
    return this.journalVouchersService.findById(wsId, firmId, voucherId);
  }
}
