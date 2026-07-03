import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DepreciationRun } from './depreciation-run.schema';
import { FixedAsset } from '../fixed-asset/fixed-asset.schema';
import { AssetCategory } from '../asset-category/asset-category.schema';
import { DepreciationMathService, DepreciationInput } from './depreciation-math.service';
import { LedgerPostingService } from '../../sales/ledger-posting/ledger-posting.service';
import { NotificationsService } from '../../../notifications/notifications.service';

function formatYearMonth(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function parseYearMonth(ym: string): Date {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1);
}

function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

const QUARTERLY_POST_MONTHS = ['01', '04', '07', '10'];

export interface RunSummary {
  runId: string;
  status: string;
  assetsProcessed: number;
  assetsSkipped: number;
  totalDepreciationPaise: number;
  ledgerEntryIds: string[];
  errorMessages: string[];
}

export interface PreviewLine {
  assetId: string;
  assetCode: string;
  name: string;
  categoryName: string;
  method: string;
  periodStart: string;
  periodEnd: string;
  amountPaise: number;
  capped: boolean;
  newNbvPaise: number;
}

@Injectable()
export class DepreciationRunService {
  private readonly logger = new Logger(DepreciationRunService.name);

  constructor(
    @InjectModel(DepreciationRun.name) private readonly runModel: Model<DepreciationRun>,
    @InjectModel(FixedAsset.name) private readonly assetModel: Model<FixedAsset>,
    @InjectModel(AssetCategory.name) private readonly categoryModel: Model<AssetCategory>,
    private readonly math: DepreciationMathService,
    private readonly ledgerPosting: LedgerPostingService,
    private readonly notifications: NotificationsService,
  ) {}

  async runForFirm(
    wsId: string,
    firmId: string,
    runMonth: string,
    runType: 'monthly' | 'quarterly' | 'manual',
    userId: string,
  ): Promise<RunSummary> {
    if (!/^\d{4}-\d{2}$/.test(runMonth)) {
      throw new BadRequestException('runMonth must be YYYY-MM');
    }
    const thisMonth = formatYearMonth(new Date());
    if (runMonth > thisMonth) {
      throw new BadRequestException('Cannot run depreciation for a future month');
    }

    // Idempotency guard via unique index (firmId, runMonth, runType)
    let run: DepreciationRun;
    try {
      run = await this.runModel.create({
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        runMonth,
        runType,
        status: 'pending',
        runAt: new Date(),
        runBy: userId,
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        const existing = await this.runModel.findOne({
          firmId: new Types.ObjectId(firmId),
          runMonth,
          runType,
        }).exec();
        if (!existing) throw err;
        return {
          runId: existing._id.toString(),
          status: existing.status,
          assetsProcessed: existing.assetsProcessed,
          assetsSkipped: existing.assetsSkipped,
          totalDepreciationPaise: existing.totalDepreciationPaise,
          ledgerEntryIds: existing.ledgerEntryIds.map((id: any) => id.toString()),
          errorMessages: existing.errorMessage ? [existing.errorMessage] : [],
        };
      }
      throw err;
    }

    const errors: string[] = [];
    let assetsProcessed = 0;
    let assetsSkipped = 0;
    let totalDepreciationPaise = 0;
    const ledgerEntryIds: Types.ObjectId[] = [];

    const assets = await this.assetModel.find({
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      status: 'active',
      isFullyDepreciated: false,
      isDeleted: false,
      nextDepreciationMonth: { $lte: runMonth },
    }).exec();

    this.logger.log(`Depreciation run ${runMonth} (${runType}) for firm ${firmId}: ${assets.length} candidate(s)`);

    for (const asset of assets) {
      try {
        // Quarterly mode: skip non-quarter months
        if (asset.depreciationFrequency === 'quarterly') {
          const month = runMonth.slice(5);
          if (!QUARTERLY_POST_MONTHS.includes(month)) {
            assetsSkipped++;
            continue;
          }
        }

        // Backdated catch-up loop: post one entry per missed month until cursor reaches runMonth
        let cursorMonth = asset.nextDepreciationMonth!;
        const stopAfterMonth = runMonth;
        const stepMonths = asset.depreciationFrequency === 'quarterly' ? 3 : 1;
        let safetyCounter = 0;

        while (cursorMonth <= stopAfterMonth && !asset.isFullyDepreciated) {
          if (++safetyCounter > 600) {
            // 50 years of monthly catch-up — bail to prevent infinite loop
            errors.push(`Asset ${asset.assetCode} catch-up safety limit hit at cursor ${cursorMonth}`);
            break;
          }

          const periodStart = parseYearMonth(cursorMonth);
          const periodEnd = addMonths(periodStart, stepMonths);
          const cat = (asset.categorySnapshot || {}) as Record<string, any>;

          const input: DepreciationInput = {
            costPaise: asset.costPaise,
            salvageValuePaise: asset.salvageValuePaise,
            depreciableAmountPaise: asset.depreciableAmountPaise,
            usefulLifeYears: asset.usefulLifeYears,
            depreciationMethod: asset.depreciationMethod as 'slm' | 'wdv',
            slmRate: asset.slmRateOverride ?? cat.slmRate ?? 0,
            wdvRate: asset.wdvRateOverride ?? cat.wdvRate ?? 0,
            shiftType: asset.shiftType as 'single' | 'double' | 'triple',
            isNesd: cat.isNesd ?? false,
            openingNbvPaise: asset.nbvPaise,
            accumulatedDepreciationPaise: asset.accumulatedDepreciationPaise,
            purchaseDate: asset.purchaseDate,
          };

          const out = this.math.computeForPeriod(input, periodStart, periodEnd);
          if (out.amountPaise > 0) {
            const entry = await this.ledgerPosting.postDepreciation(
              asset,
              out.amountPaise,
              cursorMonth,
              run._id,
              endOfMonth(periodStart),
              { userId },
            );
            ledgerEntryIds.push(entry._id);
            totalDepreciationPaise += out.amountPaise;

            asset.accumulatedDepreciationPaise += out.amountPaise;
            asset.nbvPaise = asset.costPaise - asset.accumulatedDepreciationPaise;
            asset.lastDepreciationMonth = cursorMonth;
            if (asset.nbvPaise <= asset.salvageValuePaise) {
              asset.isFullyDepreciated = true;
            }
            (asset.auditLog as any[]).push({
              at: new Date(),
              by: new Types.ObjectId(userId === 'cron' ? '000000000000000000000000' : userId),
              action: 'depreciation_posted',
              after: { runMonth: cursorMonth, amountPaise: out.amountPaise, newNbvPaise: asset.nbvPaise },
            });
          }

          // Advance cursor
          cursorMonth = formatYearMonth(addMonths(periodStart, stepMonths));
          asset.nextDepreciationMonth = cursorMonth;

          // Stop after processing the stop month
          if (cursorMonth > stopAfterMonth) break;
        }

        await asset.save();
        assetsProcessed++;
      } catch (err: any) {
        const msg = `Asset ${asset.assetCode}: ${err?.message || err}`;
        this.logger.error(msg);
        errors.push(msg);
      }
    }

    run.assetsProcessed = assetsProcessed;
    run.assetsSkipped = assetsSkipped;
    run.totalDepreciationPaise = totalDepreciationPaise;
    run.ledgerEntryIds = ledgerEntryIds;
    run.status = errors.length > 0 && assetsProcessed === 0 ? 'failed' : 'completed';
    run.errorMessage = errors.length > 0 ? errors.slice(0, 10).join('; ') : undefined;
    await run.save();

    // Best-effort push notification on success — never blocks the run result
    if (run.status === 'completed' && assetsProcessed > 0) {
      void this.notifications.sendDepreciationCompleted(wsId, firmId, {
        runMonth,
        assetsProcessed,
        totalDepreciationPaise,
        runId: run._id.toString(),
      });
    }

    return {
      runId: run._id.toString(),
      status: run.status,
      assetsProcessed,
      assetsSkipped,
      totalDepreciationPaise,
      ledgerEntryIds: ledgerEntryIds.map((id) => id.toString()),
      errorMessages: errors,
    };
  }

  async preview(wsId: string, firmId: string, runMonth: string): Promise<PreviewLine[]> {
    if (!/^\d{4}-\d{2}$/.test(runMonth)) {
      throw new BadRequestException('runMonth must be YYYY-MM');
    }
    const assets = await this.assetModel.find({
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      status: 'active',
      isFullyDepreciated: false,
      isDeleted: false,
      nextDepreciationMonth: { $lte: runMonth },
    }).exec();

    const lines: PreviewLine[] = [];
    for (const asset of assets) {
      // Quarterly skip in preview too
      if (asset.depreciationFrequency === 'quarterly' && !QUARTERLY_POST_MONTHS.includes(runMonth.slice(5))) {
        continue;
      }
      const cat = (asset.categorySnapshot || {}) as Record<string, any>;
      const stepMonths = asset.depreciationFrequency === 'quarterly' ? 3 : 1;
      const periodStart = parseYearMonth(asset.nextDepreciationMonth!);
      const periodEnd = addMonths(periodStart, stepMonths);
      const out = this.math.computeForPeriod(
        {
          costPaise: asset.costPaise,
          salvageValuePaise: asset.salvageValuePaise,
          depreciableAmountPaise: asset.depreciableAmountPaise,
          usefulLifeYears: asset.usefulLifeYears,
          depreciationMethod: asset.depreciationMethod as 'slm' | 'wdv',
          slmRate: asset.slmRateOverride ?? cat.slmRate ?? 0,
          wdvRate: asset.wdvRateOverride ?? cat.wdvRate ?? 0,
          shiftType: asset.shiftType as 'single' | 'double' | 'triple',
          isNesd: cat.isNesd ?? false,
          openingNbvPaise: asset.nbvPaise,
          accumulatedDepreciationPaise: asset.accumulatedDepreciationPaise,
          purchaseDate: asset.purchaseDate,
        },
        periodStart,
        periodEnd,
      );
      lines.push({
        assetId: asset._id.toString(),
        assetCode: asset.assetCode,
        name: asset.name,
        categoryName: cat.name || '',
        method: asset.depreciationMethod,
        periodStart: formatYearMonth(periodStart),
        periodEnd: formatYearMonth(periodEnd),
        amountPaise: out.amountPaise,
        capped: out.capped,
        newNbvPaise: asset.nbvPaise - out.amountPaise,
      });
    }
    return lines;
  }

  async listRuns(wsId: string, firmId: string, limit = 50) {
    return this.runModel.find({
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
    }).sort({ runMonth: -1, createdAt: -1 }).limit(limit).exec();
  }

  async findRun(wsId: string, firmId: string, id: string) {
    const run = await this.runModel.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
    }).exec();
    if (!run) throw new NotFoundException('Depreciation run not found');
    return run;
  }
}
