import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { LedgerEntry } from '../../sales/ledger-posting/ledger-entry.schema';
import { withFinanceSpan } from '../../common/finance-observability';

export interface FixedAssetRegisterRow {
  assetId: string;
  assetCode: string;
  assetName: string;
  category: string;
  purchaseDate: Date;
  purchaseCostPaise: number;
  accumulatedDepreciationPaise: number;
  netBookValuePaise: number;
  depreciationMethod: string;
  salvageValuePaise: number;
  usefulLifeYears: number;
  status: string;
  disposalDate: Date | null;
}

export interface DepreciationScheduleRow {
  assetId: string;
  assetName: string;
  period: string; // 'YYYY-MM'
  openingNbvPaise: number;
  depreciationPaise: number;
  closingNbvPaise: number;
}

@Injectable()
export class FixedAssetsReportsService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // Read-only fixed-asset reports: spans wrap each report method; no PostHog (no writes).
  private readonly tracer = trace.getTracer('finance');

  constructor(@InjectModel(LedgerEntry.name) private readonly ledgerModel: Model<LedgerEntry>) {}

  private db() {
    return (this.ledgerModel as any).db;
  }

  // ─── Fixed Asset Register (R-47) ─────────────────────────────────────────
  // FixedAsset schema stores accumulatedDepreciationPaise and nbvPaise directly —
  // no need to recompute from LedgerEntry. D-01 per PROJECT.md: read from schema fields.

  async getFixedAssetRegister(
    wsId: string,
    firmId: string,
  ): Promise<{ rows: FixedAssetRegisterRow[] }> {
    return withFinanceSpan(
      this.tracer,
      'finance.getFixedAssetRegister',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

        try {
          const FixedAssetModel = this.db().model('FixedAsset');
          const assets = await FixedAssetModel.find({
            workspaceId: wsOid,
            firmId: firmOid,
            isDeleted: false,
          })
            .sort({ purchaseDate: 1 })
            .lean()
            .exec();

          const rows: FixedAssetRegisterRow[] = (assets as any[]).map((asset) => ({
            assetId: asset._id.toString(),
            assetCode: asset.assetCode ?? '',
            assetName: asset.name ?? '',
            category: asset.categorySnapshot?.name ?? asset.categoryId?.toString() ?? '',
            purchaseDate: asset.purchaseDate,
            purchaseCostPaise: asset.costPaise ?? 0,
            // accumulatedDepreciationPaise is maintained by the depreciation cron on FixedAsset
            accumulatedDepreciationPaise: asset.accumulatedDepreciationPaise ?? 0,
            // nbvPaise = costPaise - accumulatedDepreciationPaise (maintained on schema)
            netBookValuePaise:
              asset.nbvPaise ?? (asset.costPaise ?? 0) - (asset.accumulatedDepreciationPaise ?? 0),
            depreciationMethod: asset.depreciationMethod ?? 'slm',
            salvageValuePaise: asset.salvageValuePaise ?? 0,
            usefulLifeYears: asset.usefulLifeYears ?? 0,
            status: asset.status ?? 'active',
            disposalDate: asset.disposalDate ?? null,
          }));

          return { rows };
        } catch {
          return { rows: [] };
        }
      },
    );
  }

  // ─── Depreciation Schedule (R-48) ────────────────────────────────────────
  // Queries LedgerEntry for depreciation postings grouped by asset + period.
  // entryType = 'depreciation'; sourceVoucherId = FixedAsset._id.
  // Account code 2001* = accumulated depreciation (credit side).

  async getDepreciationSchedule(
    wsId: string,
    firmId: string,
    assetId?: string,
  ): Promise<{ rows: DepreciationScheduleRow[] }> {
    return withFinanceSpan(
      this.tracer,
      'finance.getDepreciationSchedule',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

        try {
          const filter: any = {
            workspaceId: wsOid,
            firmId: firmOid,
            entryType: 'depreciation',
            isReversed: false,
          };
          if (assetId) filter.sourceVoucherId = new Types.ObjectId(assetId);

          const entries = await this.ledgerModel.aggregate([
            { $match: filter },
            { $unwind: '$lines' },
            // Depreciation credit lines go to accumulated depreciation (account 2001 sub-accounts)
            { $match: { 'lines.accountCode': { $regex: /^2001/ } } },
            {
              $group: {
                _id: {
                  assetId: '$sourceVoucherId',
                  year: { $year: '$entryDate' },
                  month: { $month: '$entryDate' },
                },
                depreciationPaise: { $sum: '$lines.credit' },
              },
            },
            { $sort: { '_id.assetId': 1, '_id.year': 1, '_id.month': 1 } },
          ]);

          // Compute running NBV per asset (requires opening cost from FixedAsset)
          const assetNbvMap = new Map<string, number>();
          const assetNameMap = new Map<string, string>();
          const rows: DepreciationScheduleRow[] = [];

          const FixedAssetModel = this.db().model('FixedAsset');

          for (const e of entries) {
            const aid = e._id.assetId?.toString() ?? '';
            if (!assetNbvMap.has(aid)) {
              try {
                const asset = await FixedAssetModel.findById(e._id.assetId)
                  .select('costPaise name')
                  .lean();
                assetNbvMap.set(aid, asset?.costPaise ?? 0);
                assetNameMap.set(aid, asset?.name ?? '');
              } catch {
                assetNbvMap.set(aid, 0);
                assetNameMap.set(aid, '');
              }
            }
            const openingNbv = assetNbvMap.get(aid) ?? 0;
            const closingNbv = openingNbv - e.depreciationPaise;
            assetNbvMap.set(aid, closingNbv);

            rows.push({
              assetId: aid,
              assetName: assetNameMap.get(aid) ?? '',
              period: `${e._id.year}-${String(e._id.month).padStart(2, '0')}`,
              openingNbvPaise: openingNbv,
              depreciationPaise: e.depreciationPaise,
              closingNbvPaise: closingNbv,
            });
          }
          return { rows };
        } catch {
          return { rows: [] };
        }
      },
    );
  }
}
