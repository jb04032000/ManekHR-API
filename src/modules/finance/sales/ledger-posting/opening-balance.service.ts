import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Account } from '../../ledger/account.schema';
import { LedgerPostingService } from './ledger-posting.service';
import { SetOpeningBalanceDto } from './dto/opening-balance.dto';
import { AuditService } from '../../../audit/audit.service';
import { AppModule } from '../../../../common/enums/modules.enum';
import { FyLockService } from '../../fiscal-year/fy-lock.service';

// Orchestrates per-account opening balances: posts/replaces the authoritative
// 'opening_balance' LedgerEntry (contra 3004 Opening Balance Equity) via
// LedgerPostingService, then stores the last-set value on the Account for display
// and edit prefill. Lives in the ledger-posting module so it can use both the
// Account model (via LedgerModule) and the posting service without the circular
// dependency that hosting it in the ledger module would create.
// Cross-link: reports (trial balance / account ledger / balance sheet) read the
// posted ledger entry, NOT the Account.openingBalance field.
@Injectable()
export class OpeningBalanceService {
  constructor(
    @InjectModel(Account.name) private readonly accountModel: Model<Account>,
    private readonly ledgerPosting: LedgerPostingService,
    private readonly auditService: AuditService,
    private readonly fyLock: FyLockService,
  ) {}

  async setOpeningBalance(
    workspaceId: string,
    firmId: string,
    accountId: string,
    dto: SetOpeningBalanceDto,
    userId: string,
  ): Promise<Account> {
    // Tenant scope enforced here: the account must belong to this workspace+firm
    // (never trust the accountId alone). D16 isolation.
    const account = await this.accountModel.findOne({
      _id: new Types.ObjectId(accountId),
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    });
    if (!account) throw new NotFoundException('Account not found');

    const asOfDate = new Date(dto.asOfDate);
    const amountPaise = Math.max(0, Math.round(dto.amountPaise));
    const financialYear = financialYearOf(asOfDate);

    // P0: an opening balance posts an authoritative ledger entry, so it must respect the period
    // lock + closed-FY guard like every other voucher (it bypassed this before - could rewrite a
    // filed/closed period).
    await this.fyLock.assertOpen(workspaceId, firmId, asOfDate);

    // Ledger entry is the source of truth for reports; post/replace it first.
    await this.ledgerPosting.postOpeningBalance(
      { _id: account._id, code: account.code, name: account.name },
      {
        workspaceId: account.workspaceId,
        firmId: account.firmId,
        amountPaise,
        drOrCr: dto.drOrCr,
        asOfDate,
        financialYear,
      },
      { userId },
    );

    // Store the last-set value for display + edit prefill (undefined when cleared).
    account.set(
      'openingBalance',
      amountPaise > 0 ? { amountPaise, drOrCr: dto.drOrCr, asOfDate } : undefined,
    );
    await account.save();
    // D16/R15: an opening balance posts an authoritative ledger entry (flows into trial balance /
    // balance sheet), so record who set or changed it. Awaited (was fire-and-forget) so the audit
    // row completes before we return; a logging failure is swallowed, never fatal to the posting.
    await this.auditService
      .logEvent({
        workspaceId,
        module: AppModule.FINANCE,
        entityType: 'account_opening_balance',
        entityId: accountId,
        action: 'finance.opening_balance_set',
        actorId: userId,
        meta: {
          firmId,
          accountCode: account.code,
          amountPaise,
          drOrCr: dto.drOrCr,
          asOfDate: dto.asOfDate,
        },
      })
      .catch(() => undefined);
    return account;
  }
}

// Indian financial year label (April-March) for a date, e.g. 2026-05-10 -> "2026-27".
function financialYearOf(d: Date): string {
  const yr = d.getFullYear();
  const mo = d.getMonth() + 1;
  const start = mo >= 4 ? yr : yr - 1;
  return `${start}-${String(start + 1).slice(-2)}`;
}
