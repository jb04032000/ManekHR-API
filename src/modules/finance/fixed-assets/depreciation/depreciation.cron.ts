import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { FixedAsset } from '../fixed-asset/fixed-asset.schema';
import { DepreciationRunService } from './depreciation-run.service';
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { dayBucket } from '../../../../common/scheduler/period-key';
import { CronJobKey } from '../../../../common/constants/cron.constants';

function formatYearMonth(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Monthly depreciation cron — 03:00 IST on 1st of each month.
 * Mirrors CapitalGoodsItcCron pattern (different hour to avoid resource contention).
 *
 * IMPORTANT: ScheduleModule.forRoot() is NOT registered in DepreciationModule —
 * it's already registered globally in SalaryModule (see capital-goods-itc.cron.ts comment).
 */
@Injectable()
export class DepreciationCron {
  private readonly logger = new Logger(DepreciationCron.name);

  constructor(
    @InjectModel(FixedAsset.name) private readonly assetModel: Model<FixedAsset>,
    private readonly runService: DepreciationRunService,
    private readonly singleFlight: SingleFlightService,
  ) {}

  /**
   * CRON CONTRACT - Monthly depreciation
   * Execution:   @Cron gated to worker role + Redis single-flight per day.
   *              See docs/architecture/scheduler-contract.md.
   * Schedule:    1st of each month 03:00 IST - post the month's depreciation.
   * Idempotent:  YES - DepreciationRunService guards on a DepreciationRun unique
   *              index {firmId, runMonth, runType}; a month already run is a no-op
   *              (verified in depreciation-run.service).
   * Reads:       fixed_assets
   * Writes:      depreciation ledger entries + DepreciationRun guard rows
   * Missed run:  Self-heals - the next run posts any firm/month not yet run.
   * Owner:       finance/fixed-assets
   */
  @Cron('0 3 1 * *', { timeZone: 'Asia/Kolkata' })
  async runMonthlyDepreciation(): Promise<void> {
    await this.singleFlight.runExclusive(CronJobKey.FINANCE_DEPRECIATION, dayBucket(), () =>
      this.process(),
    );
  }

  private async process(): Promise<void> {
    const thisMonth = formatYearMonth(new Date());
    this.logger.log(`Monthly depreciation cron started for ${thisMonth}`);

    // Discover distinct (workspaceId, firmId) pairs that have at least one active depreciable asset.
    const firmDocs: any[] = await this.assetModel.aggregate([
      { $match: { status: 'active', isFullyDepreciated: false, isDeleted: false } },
      { $group: { _id: { workspaceId: '$workspaceId', firmId: '$firmId' } } },
    ]);

    this.logger.log(`Found ${firmDocs.length} firm(s) with active assets`);

    for (const f of firmDocs) {
      const wsId = f._id.workspaceId.toString();
      const firmId = f._id.firmId.toString();
      try {
        const summary = await this.runService.runForFirm(
          wsId,
          firmId,
          thisMonth,
          'monthly',
          'cron',
        );
        this.logger.log(
          `Firm ${firmId}: status=${summary.status}, processed=${summary.assetsProcessed}, total=${summary.totalDepreciationPaise} paise`,
        );
      } catch (err) {
        this.logger.error(`Firm ${firmId} depreciation run failed: ${err}`);
      }
    }

    this.logger.log(`Monthly depreciation cron finished for ${thisMonth}`);
  }
}
