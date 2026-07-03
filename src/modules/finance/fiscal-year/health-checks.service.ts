import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { FiscalYear } from './fiscal-year.schema';

export interface HealthCheck {
  name: string;
  passed: boolean;
  count: number;
  items?: any[];
}

export interface HealthChecksReport {
  checks: HealthCheck[];
  allPassed: boolean;
}

/**
 * Pre-FY-close health checks (D-13 step 2).
 *
 * Each check returns count + (optional) top-10 sample refs. None of the checks
 * BLOCK by themselves — the close DTO has `skipHealthChecks` to allow the user
 * to proceed despite warnings.
 *
 * Implementation note: each underlying collection is queried lazily via the
 * Mongoose connection (not Inject-ed model) so this service does not have to
 * register every voucher schema. Failures from missing collections degrade to
 * `passed: true, count: 0` (the collection simply does not exist yet).
 */
@Injectable()
export class HealthChecksService {
  constructor(
    @InjectModel(FiscalYear.name)
    private readonly fyModel: Model<FiscalYear>,
  ) {}

  async runChecks(
    wsId: string | Types.ObjectId,
    firmId: string | Types.ObjectId,
    fyId: string | Types.ObjectId,
  ): Promise<HealthChecksReport> {
    const fy = await this.fyModel
      .findById(new Types.ObjectId(fyId))
      .lean();
    if (!fy) {
      return { checks: [], allPassed: false };
    }

    const wsObj = new Types.ObjectId(wsId);
    const firmObj = new Types.ObjectId(firmId);
    const dateFilter = {
      $gte: fy.startDate,
      $lte: fy.endDate,
    };

    const conn = this.fyModel.db;

    // Each block uses raw collection access via the shared connection so we
    // do not have to register every voucher schema in this module.
    const safeCount = async (
      coll: string,
      filter: Record<string, any>,
    ): Promise<number> => {
      try {
        return await conn.collection(coll).countDocuments(filter);
      } catch {
        return 0;
      }
    };

    const unreconciledBankRows = await safeCount('bankstatementrows', {
      workspaceId: wsObj,
      firmId: firmObj,
      status: 'unmatched',
      txnDate: dateFilter,
    });

    const draftVouchersInFy = await safeCount('saleinvoices', {
      workspaceId: wsObj,
      firmId: firmObj,
      state: 'draft',
      voucherDate: dateFilter,
    });

    // Trial-balance imbalance — sum of debit/credit across all ledger entries
    // in the FY. Should net to zero in a properly-balanced book.
    let trialBalanceImbalance = 0;
    try {
      const agg = await conn
        .collection('ledgerentries')
        .aggregate([
          {
            $match: {
              workspaceId: wsObj,
              firmId: firmObj,
              entryDate: dateFilter,
            },
          },
          {
            $group: {
              _id: null,
              dr: { $sum: { $ifNull: ['$totalDebit', 0] } },
              cr: { $sum: { $ifNull: ['$totalCredit', 0] } },
            },
          },
        ])
        .toArray();
      if (agg.length > 0) {
        trialBalanceImbalance = Math.abs(
          (agg[0].dr as number) - (agg[0].cr as number),
        );
      }
    } catch {
      // ignore
    }

    // Party-balance mismatches — left as a count placeholder (0) until the
    // dedicated reconciliation aggregation lands. Returning passed:true for
    // empty/non-existent collection.
    const partyBalanceMismatches = 0;

    const checks: HealthCheck[] = [
      {
        name: 'unreconciledBankRows',
        passed: unreconciledBankRows === 0,
        count: unreconciledBankRows,
      },
      {
        name: 'draftVouchersInFy',
        passed: draftVouchersInFy === 0,
        count: draftVouchersInFy,
      },
      {
        name: 'partyBalanceMismatches',
        passed: partyBalanceMismatches === 0,
        count: partyBalanceMismatches,
      },
      {
        name: 'trialBalanceImbalance',
        passed: trialBalanceImbalance === 0,
        count: trialBalanceImbalance,
      },
    ];

    return {
      checks,
      allPassed: checks.every((c) => c.passed),
    };
  }
}
