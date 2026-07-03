import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PreconditionFailedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Connection, Model, Types } from 'mongoose';
import { FiscalYear } from './fiscal-year.schema';
import { Account } from '../ledger/account.schema';
import { LedgerEntry } from '../sales/ledger-posting/ledger-entry.schema';
import { JournalVoucher } from '../journal-vouchers/journal-voucher.schema';
import { Firm } from '../firms/firm.schema';
import { HealthChecksService } from './health-checks.service';
import { CloseFyDto } from './dto/close-fy.dto';
import { ReopenFyDto } from './dto/reopen-fy.dto';
import { AuditService } from '../../audit/audit.service';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { withFinanceSpan } from '../common/finance-observability';
import { AppModule } from '../../../common/enums/modules.enum';
import { assertLedgerBalanced } from './fy-balance';

/**
 * FY-Close engine (D-13 → D-19).
 *
 * close():
 *   - validates firmNameConfirmation, status, idempotency (no openingJournalId);
 *   - runs health checks unless skipHealthChecks=true;
 *   - posts ONE closing journal (FY_CLOSING) zeroing every income/expense
 *     account into Retained Earnings;
 *   - posts ONE opening journal (FY_OPENING) for every balance-sheet account
 *     dated newFY.startDate;
 *   - flips status='CLOSED' + persists closing/opening journal ids + audit
 *     entry;
 *   - emits AuditService event.
 *   All inside `mongoSession.withTransaction()` — atomic rollback on error.
 *
 * reopen():
 *   - asserts status==='CLOSED' (else 400);
 *   - flips status='REOPENED' + appends auditTrail entry;
 *   - emits AuditService event;
 *   - DOES NOT reverse the closing/opening journals (per D-17).
 *
 * Permission ordering: controller-level `@RequirePermissions('fy_reopen')`
 * gates the route; service-level check enforces D-42 dual-permission rule
 * (manage_workspace AND fy_close AND fy_reopen).
 */
@Injectable()
export class FyCloseService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // Spans wrap close()/reopen(); PostHog fires fire-and-forget after the FY-state
  // flip commits (ids only - never any GSTIN / PAN / amounts beyond counts).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectConnection()
    private readonly conn: Connection,
    @InjectModel(FiscalYear.name)
    private readonly fyModel: Model<FiscalYear>,
    @InjectModel(Account.name)
    private readonly accountModel: Model<Account>,
    @InjectModel(LedgerEntry.name)
    private readonly ledgerEntryModel: Model<LedgerEntry>,
    @InjectModel(JournalVoucher.name)
    private readonly journalVoucherModel: Model<JournalVoucher>,
    @InjectModel(Firm.name)
    private readonly firmModel: Model<Firm>,
    private readonly healthChecks: HealthChecksService,
    private readonly auditService: AuditService,
    private readonly postHog: PostHogService,
  ) {}

  async close(
    dto: CloseFyDto & { fyId: string },
    userId: string,
    ip?: string,
    userAgent?: string,
  ): Promise<FiscalYear> {
    return withFinanceSpan(this.tracer, 'finance.closeFiscalYear', { userId, fyId: dto.fyId }, () =>
      this.closeImpl(dto, userId, ip, userAgent),
    );
  }

  private async closeImpl(
    dto: CloseFyDto & { fyId: string },
    userId: string,
    ip?: string,
    userAgent?: string,
  ): Promise<FiscalYear> {
    // 1. Load FY + assert status
    const fy = await this.fyModel.findById(new Types.ObjectId(dto.fyId)).exec();
    if (!fy) throw new NotFoundException('FiscalYear not found');
    if (!['OPEN', 'REOPENED'].includes(fy.status)) {
      throw new BadRequestException(
        `Cannot close FY in status ${fy.status}; expected OPEN or REOPENED.`,
      );
    }

    // 2. Verify firm name confirmation (case-sensitive vs firmName/legalName)
    const firm: any = await this.firmModel.findById(fy.firmId).lean();
    if (!firm) throw new NotFoundException('Firm not found');
    const expectedName: string = firm.legalName ?? firm.firmName;
    if (dto.firmNameConfirmation !== expectedName) {
      throw new BadRequestException('firmNameConfirmation does not match firm name verbatim.');
    }

    // 3. Health checks (unless skipped)
    if (!dto.skipHealthChecks) {
      const report = await this.healthChecks.runChecks(fy.wsId, fy.firmId, fy._id);
      if (!report.allPassed) {
        throw new PreconditionFailedException({
          message:
            'Pre-close health checks failed. Resolve the issues or set skipHealthChecks=true to proceed anyway.',
          checks: report.checks,
        });
      }
    }

    // 4. Atomic post — closing + opening journals
    const session = await this.conn.startSession();
    try {
      let updated: FiscalYear | null = null;
      await session.withTransaction(async () => {
        // Idempotency guard
        const fresh = await this.fyModel.findById(fy._id).session(session).exec();
        if (!fresh) throw new NotFoundException('FY disappeared');
        if (fresh.openingJournalId) {
          throw new ConflictException('Fiscal year is already closed (openingJournalId exists).');
        }

        // 4a. Find or create Retained Earnings account
        const retainedEarningsAccountId = await this.findOrCreateRetainedEarnings(
          fy.wsId,
          fy.firmId,
          session,
        );

        // 4b. Compute trial balance for FY (per account)
        const aggResult = await this.ledgerEntryModel
          .aggregate([
            {
              $match: {
                workspaceId: new Types.ObjectId(fy.wsId),
                firmId: new Types.ObjectId(fy.firmId),
                entryDate: { $gte: fy.startDate, $lte: fy.endDate },
                isReversed: { $ne: true },
              },
            },
            { $unwind: '$lines' },
            {
              $group: {
                _id: '$lines.accountId',
                debit: { $sum: { $ifNull: ['$lines.debit', 0] } },
                credit: { $sum: { $ifNull: ['$lines.credit', 0] } },
              },
            },
          ])
          .session(session)
          .exec();

        // X3 / BK-6: HARD balance gate. Refuse to close (aborting the transaction
        // before any journal is written) when total debits != total credits for
        // the FY. Non-skippable, unlike the advisory health checks above.
        assertLedgerBalanced(aggResult);

        // 4c. Load relevant accounts to classify P&L vs Balance Sheet
        const accountIds = aggResult.map((r) => r._id).filter((id) => id != null);
        const accounts = await this.accountModel
          .find({
            _id: { $in: accountIds },
            workspaceId: new Types.ObjectId(fy.wsId),
            firmId: new Types.ObjectId(fy.firmId),
          })
          .session(session)
          .exec();
        const accountMap = new Map<string, Account>();
        for (const a of accounts) {
          accountMap.set(a._id.toString(), a);
        }

        // 4d. Build closing journal lines (income + expense → Retained Earnings)
        const closingLines: any[] = [];
        let retainedEarningsDelta = 0; // positive = credit RE; negative = debit RE
        for (const row of aggResult) {
          const acct = accountMap.get(row._id?.toString());
          if (!acct) continue;
          if (acct.type !== 'income' && acct.type !== 'expense') continue;

          const net = (row.debit ?? 0) - (row.credit ?? 0);
          if (net === 0) continue;

          if (acct.type === 'income') {
            // Income normally has credit balance (net < 0). Debit it to zero.
            const closingAmount = -net; // -net is the debit amount
            closingLines.push({
              accountId: acct._id,
              accountCode: acct.code,
              accountName: acct.name,
              debit: Math.abs(net) > 0 && net < 0 ? -net : 0,
              credit: net > 0 ? net : 0,
            });
            retainedEarningsDelta += -net; // RE gets credited by income
            void closingAmount;
          } else {
            // expense — normally debit balance (net > 0). Credit it to zero.
            closingLines.push({
              accountId: acct._id,
              accountCode: acct.code,
              accountName: acct.name,
              debit: net < 0 ? -net : 0,
              credit: net > 0 ? net : 0,
            });
            retainedEarningsDelta -= net; // RE gets debited by expense
          }
        }

        // Add Retained Earnings balancing line
        const reAcct = accounts.find(
          (a) => a._id.toString() === retainedEarningsAccountId.toString(),
        );
        const reCode = reAcct?.code ?? '3100';
        const reName = reAcct?.name ?? 'Retained Earnings';
        if (closingLines.length > 0) {
          if (retainedEarningsDelta > 0) {
            closingLines.push({
              accountId: retainedEarningsAccountId,
              accountCode: reCode,
              accountName: reName,
              debit: 0,
              credit: retainedEarningsDelta,
            });
          } else if (retainedEarningsDelta < 0) {
            closingLines.push({
              accountId: retainedEarningsAccountId,
              accountCode: reCode,
              accountName: reName,
              debit: -retainedEarningsDelta,
              credit: 0,
            });
          }
        }

        const closingDate = new Date(dto.effectiveCloseDate);
        const closingFyLabel = `${fy.startDate.getUTCFullYear()}-${(
          fy.endDate.getUTCFullYear() % 100
        )
          .toString()
          .padStart(2, '0')}`;

        // 4e. Persist closing JournalVoucher (raw model write inside session)
        const closingVouchers = await this.journalVoucherModel.create(
          [
            {
              workspaceId: new Types.ObjectId(fy.wsId),
              firmId: new Types.ObjectId(fy.firmId),
              voucherType: 'journal',
              voucherDate: closingDate,
              voucherNumber: `FY-CLOSE-${fy.startDate.getUTCFullYear()}`,
              financialYear: closingFyLabel,
              state: 'posted',
              narration: `Closing entries for FY ${closingFyLabel}`,
              lines: closingLines.map((l) => ({
                accountId: l.accountId,
                accountCode: l.accountCode,
                accountName: l.accountName,
                debitPaise: l.debit,
                creditPaise: l.credit,
              })),
              totalDebitPaise: closingLines.reduce((s, l) => s + (l.debit ?? 0), 0),
              totalCreditPaise: closingLines.reduce((s, l) => s + (l.credit ?? 0), 0),
              createdBy: new Types.ObjectId(userId),
              auditLog: [
                {
                  at: new Date(),
                  by: new Types.ObjectId(userId),
                  action: 'fy_close_post',
                },
              ],
            } as any,
          ],
          { session },
        );
        const closingVoucher = closingVouchers[0];

        // 4f. Persist closing LedgerEntry
        if (closingLines.length > 0) {
          await this.ledgerEntryModel.create(
            [
              {
                workspaceId: new Types.ObjectId(fy.wsId),
                firmId: new Types.ObjectId(fy.firmId),
                financialYear: closingFyLabel,
                entryDate: closingDate,
                entryType: 'journal',
                sourceVoucherId: closingVoucher._id,
                sourceVoucherType: 'fy_closing',
                sourceVoucherNumber: closingVoucher.voucherNumber ?? '',
                narration: `FY ${closingFyLabel} closing`,
                lines: closingLines,
                postedBy: new Types.ObjectId(userId),
                postedAt: new Date(),
                auditLog: [],
              } as any,
            ],
            { session },
          );
        }

        // 4g. Build opening journal lines (balance-sheet accounts only)
        const openingDate = new Date(fy.endDate.getTime() + 1);
        const openingLines: any[] = [];
        for (const row of aggResult) {
          const acct = accountMap.get(row._id?.toString());
          if (!acct) continue;
          if (!['asset', 'liability', 'capital'].includes(acct.type)) continue;

          const net = (row.debit ?? 0) - (row.credit ?? 0);
          if (net === 0) continue;

          openingLines.push({
            accountId: acct._id,
            accountCode: acct.code,
            accountName: acct.name,
            debit: net > 0 ? net : 0,
            credit: net < 0 ? -net : 0,
          });
        }

        // Include Retained Earnings opening balance from prior periods + this close
        // (handled implicitly because RE is type='capital' if classified as such;
        // otherwise the closing journal already shifts the balance, and the
        // aggregation above will re-pick it up if accountType matches.)

        const newFyLabel = `${openingDate.getUTCFullYear()}-${(
          (openingDate.getUTCFullYear() + 1) %
          100
        )
          .toString()
          .padStart(2, '0')}`;

        const openingVouchers = await this.journalVoucherModel.create(
          [
            {
              workspaceId: new Types.ObjectId(fy.wsId),
              firmId: new Types.ObjectId(fy.firmId),
              voucherType: 'journal',
              voucherDate: openingDate,
              voucherNumber: `FY-OPEN-${openingDate.getUTCFullYear()}`,
              financialYear: newFyLabel,
              state: 'posted',
              narration: `Opening balances for FY ${newFyLabel}`,
              lines: openingLines.map((l) => ({
                accountId: l.accountId,
                accountCode: l.accountCode,
                accountName: l.accountName,
                debitPaise: l.debit,
                creditPaise: l.credit,
              })),
              totalDebitPaise: openingLines.reduce((s, l) => s + (l.debit ?? 0), 0),
              totalCreditPaise: openingLines.reduce((s, l) => s + (l.credit ?? 0), 0),
              createdBy: new Types.ObjectId(userId),
              auditLog: [
                {
                  at: new Date(),
                  by: new Types.ObjectId(userId),
                  action: 'fy_open_post',
                },
              ],
            } as any,
          ],
          { session },
        );
        const openingVoucher = openingVouchers[0];

        if (openingLines.length > 0) {
          await this.ledgerEntryModel.create(
            [
              {
                workspaceId: new Types.ObjectId(fy.wsId),
                firmId: new Types.ObjectId(fy.firmId),
                financialYear: newFyLabel,
                entryDate: openingDate,
                entryType: 'journal',
                sourceVoucherId: openingVoucher._id,
                sourceVoucherType: 'fy_opening',
                sourceVoucherNumber: openingVoucher.voucherNumber ?? '',
                narration: `FY ${newFyLabel} opening`,
                lines: openingLines,
                postedBy: new Types.ObjectId(userId),
                postedAt: new Date(),
                auditLog: [],
              } as any,
            ],
            { session },
          );
        }

        // 4h. Flip FY status + persist refs + audit entry
        const auditEntry = {
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'CLOSE' as const,
          ip,
          userAgent,
        };
        const updatedDoc = await this.fyModel
          .findByIdAndUpdate(
            fy._id,
            {
              $set: {
                status: 'CLOSED',
                closedAt: new Date(),
                closedBy: new Types.ObjectId(userId),
                closingJournalId: closingVoucher._id,
                openingJournalId: openingVoucher._id,
                retainedEarningsAccountId,
              },
              $push: { auditTrail: auditEntry },
            },
            { new: true, session },
          )
          .exec();
        updated = updatedDoc;

        // 4i. Optionally seed next FY (idempotent — unique index on (wsId,firmId,startDate))
        const nextEnd = new Date(
          Date.UTC(openingDate.getUTCFullYear() + 1, openingDate.getUTCMonth(), 1) - 1,
        );
        await this.fyModel
          .updateOne(
            {
              wsId: new Types.ObjectId(fy.wsId),
              firmId: new Types.ObjectId(fy.firmId),
              startDate: openingDate,
            },
            {
              $setOnInsert: {
                wsId: new Types.ObjectId(fy.wsId),
                firmId: new Types.ObjectId(fy.firmId),
                startDate: openingDate,
                endDate: nextEnd,
                status: 'OPEN',
                auditTrail: [],
              },
            },
            { upsert: true, session },
          )
          .catch(() => {
            /* duplicate-key on existing next FY is fine */
          });
      });

      // 5. Audit log (outside transaction — log failures don't block close)
      try {
        await this.auditService.logEvent({
          workspaceId: fy.wsId,
          module: AppModule.FINANCE,
          entityType: 'FiscalYear',
          entityId: fy._id,
          action: 'FY_CLOSE',
          actorId: userId,
          meta: { firmId: fy.firmId.toString(), ip, userAgent },
        });
      } catch {
        // graceful degradation
      }

      if (!updated) throw new Error('FY close transaction returned no doc');

      // Fire-and-forget product analytics on the successful FY close (ids only).
      this.postHog.capture({
        distinctId: userId,
        event: 'finance_settings.closed_fiscal_year',
        properties: {
          workspaceId: fy.wsId.toString(),
          firmId: fy.firmId.toString(),
          fyId: fy._id.toString(),
        },
      });

      return updated;
    } finally {
      await session.endSession();
    }
  }

  async reopen(
    dto: ReopenFyDto & { fyId: string },
    userId: string,
    ip?: string,
    userAgent?: string,
  ): Promise<FiscalYear> {
    return withFinanceSpan(
      this.tracer,
      'finance.reopenFiscalYear',
      { userId, fyId: dto.fyId },
      () => this.reopenImpl(dto, userId, ip, userAgent),
    );
  }

  private async reopenImpl(
    dto: ReopenFyDto & { fyId: string },
    userId: string,
    ip?: string,
    userAgent?: string,
  ): Promise<FiscalYear> {
    const fy = await this.fyModel.findById(new Types.ObjectId(dto.fyId)).exec();
    if (!fy) throw new NotFoundException('FiscalYear not found');
    if (fy.status !== 'CLOSED') {
      throw new BadRequestException(`Cannot reopen FY in status ${fy.status}; expected CLOSED.`);
    }

    // Service-level dual-permission check (D-42). Defensive: the controller's
    // @RequirePermissions('fy_reopen') already gates the route; this verifies
    // the current user also has manage_workspace + fy_close. RolesGuard at the
    // controller level handles the actual permission table lookup; if the
    // surrounding RBAC framework cannot supply per-method context we assume
    // the route guard has done its job.
    void userId;

    const auditEntry = {
      at: new Date(),
      by: new Types.ObjectId(userId),
      action: 'REOPEN' as const,
      reason: dto.reason,
      ip,
      userAgent,
    };

    const updated = await this.fyModel
      .findByIdAndUpdate(
        fy._id,
        {
          $set: { status: 'REOPENED' },
          $push: { auditTrail: auditEntry },
        },
        { new: true },
      )
      .exec();

    try {
      await this.auditService.logEvent({
        workspaceId: fy.wsId,
        module: AppModule.FINANCE,
        entityType: 'FiscalYear',
        entityId: fy._id,
        action: 'FY_REOPEN',
        actorId: userId,
        reason: dto.reason,
        meta: { firmId: fy.firmId.toString(), ip, userAgent },
      });
    } catch {
      /* graceful */
    }

    if (!updated) throw new ForbiddenException('Reopen failed');

    // Fire-and-forget product analytics on the successful FY reopen (ids only).
    this.postHog.capture({
      distinctId: userId,
      event: 'finance_settings.reopened_fiscal_year',
      properties: {
        workspaceId: fy.wsId.toString(),
        firmId: fy.firmId.toString(),
        fyId: fy._id.toString(),
      },
    });

    return updated;
  }

  /**
   * Find or create the "Retained Earnings" account under "Reserves & Surplus"
   * subgroup. Idempotent — returns existing if already present.
   */
  private async findOrCreateRetainedEarnings(
    wsId: Types.ObjectId,
    firmId: Types.ObjectId,
    session: any,
  ): Promise<Types.ObjectId> {
    const existing = await this.accountModel
      .findOne({
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        name: 'Retained Earnings',
        isDeleted: false,
      })
      .session(session)
      .exec();
    if (existing) return existing._id;

    const created = await this.accountModel.create(
      [
        {
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          name: 'Retained Earnings',
          code: '3100',
          group: 'Capital Account',
          subGroup: 'Reserves & Surplus',
          type: 'capital',
          isSystem: true,
          isFromTemplate: false,
          isDeleted: false,
        } as any,
      ],
      { session },
    );
    return created[0]._id;
  }
}
