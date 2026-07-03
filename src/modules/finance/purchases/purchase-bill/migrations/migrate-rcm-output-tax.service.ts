import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { ClientSession, Model, Types } from 'mongoose';
import { PurchaseBill } from '../purchase-bill.schema';
import { LedgerEntry, LedgerLine } from '../../../sales/ledger-posting/ledger-entry.schema';
import { Account } from '../../../ledger/account.schema';
import { planRcmCorrection, isIntraStateFromTax } from '../purchase-bill-rcm-migration.rules';

/** Per-bill outcome line for the dry-run / apply report. */
interface RcmMigrationDetail {
  billId: string;
  voucherNumber?: string;
  outcome:
    | 'corrected'
    | 'already_migrated'
    | 'no_ledger_entry'
    | 'no_creditor_line'
    | 'creditor_underflow'
    | 'missing_output_account'
    | 'error';
  outputTaxPaise?: number;
  /** Bills with payments need a manual payable/over-payment review (RCM means
   *  the firm should not have paid the vendor the tax). Flagged, never auto-touched. */
  amountPaidPaise?: number;
  note?: string;
}

export interface RcmMigrationReport {
  dryRun: boolean;
  scanned: number;
  corrected: number;
  alreadyMigrated: number;
  skipped: number;
  errors: number;
  details: RcmMigrationDetail[];
}

const OUTPUT_ACCOUNT_NAME: Record<string, string> = {
  '2006': 'Output IGST Payable',
  '2007': 'Output CGST Payable',
  '2008': 'Output SGST Payable',
};

/**
 * One-time migration: correct reverse-charge (RCM) purchase-bill ledger entries
 * posted BEFORE commit 8bafb5c. Amends each affected bill's existing
 * `purchase_bill` ledger entry to ADD the missing Cr Output GST Payable lines
 * (2006/2007/2008) and REDUCE the Cr 2001 Creditors line by the same total tax
 * - leaving the entry balanced and identical to a correctly-posted RCM bill.
 *
 * SAFETY:
 *  - Idempotent: a bill whose entry already carries an output-payable credit is
 *    skipped (`already_migrated`). Safe to re-run.
 *  - Dry-run first: gated by env `RCM_OUTPUT_TAX_MIGRATION`:
 *      'dry-run' -> scans + reports, writes NOTHING (default behaviour if the
 *                   value is anything other than 'apply')
 *      'apply'   -> performs the amendment inside a per-bill transaction
 *      unset     -> migration does not run at all
 *  - Books are NOT mutated for bill FIELDS (amountDue/netPayable). Bills that
 *    already carry payments are reported (`amountPaidPaise`) for a manual
 *    payable/over-payment review - under RCM the tax should never have been paid
 *    to the supplier, which is a business recovery decision, not an auto-fix.
 */
@Injectable()
export class MigrateRcmOutputTaxService implements OnModuleInit {
  private readonly logger = new Logger(MigrateRcmOutputTaxService.name);

  constructor(
    @InjectModel(PurchaseBill.name) private readonly billModel: Model<PurchaseBill>,
    @InjectModel(LedgerEntry.name) private readonly ledgerModel: Model<LedgerEntry>,
    @InjectModel(Account.name) private readonly accountModel: Model<Account>,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const mode = this.config.get<string>('RCM_OUTPUT_TAX_MIGRATION', '');
    if (mode !== 'dry-run' && mode !== 'apply') return; // unset -> do not run
    try {
      const report = await this.run({ dryRun: mode !== 'apply' });
      this.logger.log(`RCM output-tax migration (${mode}): ${JSON.stringify(report)}`);
    } catch (err) {
      const e = err as Error;
      this.logger.error(`RCM output-tax migration failed: ${e?.message ?? String(err)}`, e?.stack);
    }
  }

  /**
   * Scan every posted reverse-charge purchase bill, correct (or, in dry-run,
   * report) those missing the RCM output-tax liability. Returns a full report.
   */
  async run(opts: { dryRun: boolean }): Promise<RcmMigrationReport> {
    const { dryRun } = opts;
    const report: RcmMigrationReport = {
      dryRun,
      scanned: 0,
      corrected: 0,
      alreadyMigrated: 0,
      skipped: 0,
      errors: 0,
      details: [],
    };

    const bills = await this.billModel
      .find({ state: 'posted', isReverseCharge: true })
      .select(
        '_id workspaceId firmId voucherNumber isReverseCharge cgstPaise sgstPaise igstPaise amountPaidPaise',
      )
      .lean()
      .exec();

    for (const bill of bills) {
      report.scanned++;
      const billId = String((bill as any)._id);
      const voucherNumber = (bill as any).voucherNumber as string | undefined;
      const amountPaidPaise = (bill as any).amountPaidPaise as number | undefined;
      try {
        const entry = await this.ledgerModel
          .findOne({
            workspaceId: (bill as any).workspaceId,
            firmId: (bill as any).firmId,
            sourceVoucherId: (bill as any)._id,
            sourceVoucherType: 'purchase_bill',
          })
          .exec();

        if (!entry) {
          report.skipped++;
          report.details.push({ billId, voucherNumber, outcome: 'no_ledger_entry' });
          continue;
        }

        const plan = planRcmCorrection(entry.lines, bill as any, isIntraStateFromTax(bill as any));

        if (!plan.applicable || plan.alreadyMigrated) {
          report.alreadyMigrated += plan.alreadyMigrated ? 1 : 0;
          report.skipped += plan.applicable ? 0 : 1;
          report.details.push({
            billId,
            voucherNumber,
            outcome: 'already_migrated',
          });
          continue;
        }

        const creditorLine = entry.lines.find((l) => l.accountCode === '2001' && l.credit > 0);
        if (!creditorLine) {
          report.skipped++;
          report.details.push({ billId, voucherNumber, outcome: 'no_creditor_line' });
          continue;
        }
        if (creditorLine.credit < plan.creditorReductionPaise) {
          report.skipped++;
          report.details.push({
            billId,
            voucherNumber,
            outcome: 'creditor_underflow',
            note: `creditor credit ${creditorLine.credit} < reduction ${plan.creditorReductionPaise}`,
          });
          continue;
        }

        // Resolve the output-payable account docs (must exist in the firm's CoA).
        const newLines: LedgerLine[] = [];
        let missingAccount = false;
        for (const out of plan.outputTaxLines) {
          const acc = await this.accountModel
            .findOne({
              workspaceId: (bill as any).workspaceId,
              firmId: (bill as any).firmId,
              code: out.accountCode,
            })
            .lean()
            .exec();
          if (!acc) {
            missingAccount = true;
            break;
          }
          newLines.push({
            accountId: (acc as any)._id as Types.ObjectId,
            accountCode: out.accountCode,
            accountName:
              (acc as any).name ?? OUTPUT_ACCOUNT_NAME[out.accountCode] ?? out.accountCode,
            debit: 0,
            credit: out.paise,
          });
        }
        if (missingAccount) {
          report.skipped++;
          report.details.push({ billId, voucherNumber, outcome: 'missing_output_account' });
          continue;
        }

        if (!dryRun) {
          await this.applyCorrection(
            entry,
            creditorLine.accountCode,
            plan.creditorReductionPaise,
            newLines,
          );
        }

        report.corrected++;
        report.details.push({
          billId,
          voucherNumber,
          outcome: 'corrected',
          outputTaxPaise: plan.creditorReductionPaise,
          amountPaidPaise,
          note:
            amountPaidPaise && amountPaidPaise > 0
              ? 'PAID bill — review vendor over-payment of the RCM tax (payable not auto-adjusted)'
              : undefined,
        });
      } catch (err) {
        report.errors++;
        report.details.push({
          billId,
          voucherNumber,
          outcome: 'error',
          note: (err as Error)?.message ?? String(err),
        });
      }
    }

    return report;
  }

  /**
   * Amend the entry in a transaction: reduce the creditor credit by the total
   * RCM tax, append the output-payable credit lines, and record an audit entry.
   * Re-checks idempotency inside the transaction (no output-payable credit yet)
   * so concurrent/repeat runs cannot double-apply.
   */
  private async applyCorrection(
    entry: LedgerEntry,
    creditorAccountCode: string,
    creditorReductionPaise: number,
    newLines: LedgerLine[],
  ): Promise<void> {
    const session: ClientSession = await this.ledgerModel.db.startSession();
    try {
      await session.withTransaction(async () => {
        const fresh = await this.ledgerModel.findById(entry._id).session(session).exec();
        if (!fresh) return;
        const alreadyHasOutput = fresh.lines.some(
          (l) => ['2006', '2007', '2008'].includes(l.accountCode) && l.credit > 0,
        );
        if (alreadyHasOutput) return; // idempotent guard inside the txn

        const creditor = fresh.lines.find(
          (l) => l.accountCode === creditorAccountCode && l.credit > 0,
        );
        if (!creditor || creditor.credit < creditorReductionPaise) return;
        const beforeCreditorCredit = creditor.credit;
        creditor.credit -= creditorReductionPaise;
        fresh.lines.push(...newLines);
        fresh.auditLog.push({
          at: new Date(),
          by: new Types.ObjectId('000000000000000000000000'), // system actor (migration)
          action: 'rcm_output_tax_migration',
          before: { creditorCredit: beforeCreditorCredit, outputTaxLines: 0 },
          after: { creditorCredit: creditor.credit, outputTaxLines: newLines.length },
          reason: 'Backfill RCM output-tax liability + correct creditor over-credit (pre-8bafb5c)',
        });
        fresh.markModified('lines');
        fresh.markModified('auditLog');
        await fresh.save({ session });
      });
    } finally {
      await session.endSession();
    }
  }
}
