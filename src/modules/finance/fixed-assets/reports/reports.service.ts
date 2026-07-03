import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { FixedAsset } from '../fixed-asset/fixed-asset.schema';
import { AssetRegisterDto } from './dto/asset-register.dto';
import { DepreciationScheduleDto } from './dto/depreciation-schedule.dto';
import { BlockSummaryDto } from './dto/block-summary.dto';
import { AdditionsDisposalsDto } from './dto/additions-disposals.dto';
import { computeBlockDepreciation, isHalfYearAddition } from './block-depreciation.util';
import { nbvAtDisposalPaise } from './disposal-nbv.util';

@Injectable()
export class ReportsService {
  constructor(@InjectModel(FixedAsset.name) private readonly assetModel: Model<FixedAsset>) {}

  // ─── Asset Register ─────────────────────────────────────────────────────────

  async assetRegister(wsId: string, firmId: string, dto: AssetRegisterDto) {
    const filter: Record<string, any> = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };
    if (dto.financialYear) filter.financialYear = dto.financialYear;
    if (dto.categoryId) filter.categoryId = new Types.ObjectId(dto.categoryId);
    if (dto.status && dto.status !== 'all') {
      filter.status = dto.status;
    } else if (!dto.status) {
      filter.status = 'active';
    }

    const assets = await this.assetModel.find(filter).sort({ assetCode: 1 }).exec();

    const groupMap = new Map<
      string,
      {
        categoryId: string;
        categoryName: string;
        assets: any[];
        totals: { cost: number; accumulated: number; nbv: number };
      }
    >();
    let grandCost = 0,
      grandAcc = 0,
      grandNbv = 0;

    for (const a of assets) {
      const catKey = a.categoryId?.toString() ?? 'uncategorised';
      const catName = (a.categorySnapshot as any)?.name ?? 'Uncategorised';
      let group = groupMap.get(catKey);
      if (!group) {
        group = {
          categoryId: catKey,
          categoryName: catName,
          assets: [],
          totals: { cost: 0, accumulated: 0, nbv: 0 },
        };
        groupMap.set(catKey, group);
      }
      group.assets.push({
        _id: a._id,
        assetCode: a.assetCode,
        name: a.name,
        purchaseDate: a.purchaseDate,
        costPaise: a.costPaise,
        accumulatedDepreciationPaise: a.accumulatedDepreciationPaise,
        nbvPaise: a.nbvPaise,
        status: a.status,
        partyName: a.partyName,
        depreciationMethod: a.depreciationMethod,
        shiftType: a.shiftType,
      });
      group.totals.cost += a.costPaise;
      group.totals.accumulated += a.accumulatedDepreciationPaise;
      group.totals.nbv += a.nbvPaise;
      grandCost += a.costPaise;
      grandAcc += a.accumulatedDepreciationPaise;
      grandNbv += a.nbvPaise;
    }

    return {
      groupedByCategory: Array.from(groupMap.values()),
      grandTotals: { cost: grandCost, accumulated: grandAcc, nbv: grandNbv },
      asOfDate: dto.asOfDate ?? new Date().toISOString().slice(0, 10),
      filterApplied: dto,
    };
  }

  // ─── Depreciation Schedule (per asset) ──────────────────────────────────────

  async depreciationSchedule(
    wsId: string,
    firmId: string,
    assetId: string,
    dto: DepreciationScheduleDto,
  ) {
    const asset = await this.assetModel
      .findOne({
        _id: new Types.ObjectId(assetId),
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
      })
      .exec();
    if (!asset) throw new NotFoundException('Fixed asset not found');

    const lines: any[] = [];
    let runningAcc = 0;

    for (const entry of (asset.auditLog as any[]) ?? []) {
      if (entry.action !== 'depreciation_posted') continue;
      const after = entry.after ?? {};
      if (dto.fromMonth && after.runMonth < dto.fromMonth) continue;
      if (dto.toMonth && after.runMonth > dto.toMonth) continue;
      runningAcc += after.amountPaise ?? 0;
      lines.push({
        runMonth: after.runMonth,
        amountPaise: after.amountPaise,
        accumulatedAfterPaise: runningAcc,
        nbvAfterPaise: after.newNbvPaise,
        postedAt: entry.at,
        postedBy: entry.by?.toString(),
      });
    }

    return {
      assetId: asset._id.toString(),
      assetCode: asset.assetCode,
      name: asset.name,
      costPaise: asset.costPaise,
      salvageValuePaise: asset.salvageValuePaise,
      openingNbvPaise: asset.openingNbvPaise,
      currentAccumulatedPaise: asset.accumulatedDepreciationPaise,
      currentNbvPaise: asset.nbvPaise,
      depreciationMethod: asset.depreciationMethod,
      lines,
    };
  }

  // ─── Block Summary (IT Act WDV) ──────────────────────────────────────────────

  async blockSummary(wsId: string, firmId: string, dto: BlockSummaryDto) {
    // financialYear format: "YYYY-YY", e.g. "2024-25"
    // Indian FY: April 1 of start year to March 31 of end year
    const startYear = parseInt(dto.financialYear.slice(0, 4), 10);
    const fyStart = new Date(startYear, 3, 1); // April 1 of start year
    const fyEnd = new Date(startYear + 1, 2, 31); // March 31 of next year

    const assets = await this.assetModel
      .find({
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .select(
        'purchaseDate disposalDate costPaise openingNbvPaise disposalProceedsPaise categorySnapshot',
      )
      .lean()
      .exec();

    const blockMap = new Map<
      string,
      {
        block: string;
        itActRate: number;
        openingWdvPaise: number;
        additionsPaise: number;
        disposalsPaise: number;
        depreciationPaise: number;
        closingWdvPaise: number;
        assetCount: number;
      }
    >();

    // Per-block additions split by the s.32 180-day test (full vs half rate).
    const additionsSplit = new Map<string, { full: number; half: number }>();

    for (const a of assets) {
      const cat: any = a.categorySnapshot ?? {};
      const block = cat.itActBlock ?? 'Unclassified';
      const rate = cat.itActRate ?? 0;
      let bucket = blockMap.get(block);
      if (!bucket) {
        bucket = {
          block,
          itActRate: rate,
          openingWdvPaise: 0,
          additionsPaise: 0,
          disposalsPaise: 0,
          depreciationPaise: 0,
          closingWdvPaise: 0,
          assetCount: 0,
        };
        blockMap.set(block, bucket);
      }
      bucket.assetCount += 1;

      // Asset acquired before this FY contributes to opening WDV
      if (a.purchaseDate < fyStart) {
        bucket.openingWdvPaise += a.openingNbvPaise;
      } else if (a.purchaseDate >= fyStart && a.purchaseDate <= fyEnd) {
        // Addition during this FY — split by the s.32 180-day half-rate proviso.
        bucket.additionsPaise += a.costPaise;
        const split = additionsSplit.get(block) ?? { full: 0, half: 0 };
        if (isHalfYearAddition(a.purchaseDate, fyEnd)) split.half += a.costPaise;
        else split.full += a.costPaise;
        additionsSplit.set(block, split);
      }

      // Disposal during this FY. Under Sec 43(6) the block is reduced by the
      // moneys payable (sale proceeds), NOT the asset's original cost.
      if (a.disposalDate && a.disposalDate >= fyStart && a.disposalDate <= fyEnd) {
        bucket.disposalsPaise += a.disposalProceedsPaise ?? 0;
      }
    }

    // IT Act WDV depreciation per block: full rate on opening + full-year
    // additions, half rate only on additions used < 180 days (s.32 proviso).
    for (const b of blockMap.values()) {
      const split = additionsSplit.get(b.block) ?? { full: 0, half: 0 };
      const { depreciationPaise, closingWdvPaise } = computeBlockDepreciation({
        openingWdvPaise: b.openingWdvPaise,
        additionsFullPaise: split.full,
        additionsHalfPaise: split.half,
        disposalsPaise: b.disposalsPaise,
        itActRate: b.itActRate,
      });
      b.depreciationPaise = depreciationPaise;
      b.closingWdvPaise = closingWdvPaise;
    }

    return {
      financialYear: dto.financialYear,
      blocks: Array.from(blockMap.values()).sort((a, b) => a.block.localeCompare(b.block)),
      grandTotals: this.sumBlocks(Array.from(blockMap.values())),
    };
  }

  private sumBlocks(blocks: any[]) {
    return blocks.reduce(
      (acc, b) => ({
        openingWdvPaise: acc.openingWdvPaise + b.openingWdvPaise,
        additionsPaise: acc.additionsPaise + b.additionsPaise,
        disposalsPaise: acc.disposalsPaise + b.disposalsPaise,
        depreciationPaise: acc.depreciationPaise + b.depreciationPaise,
        closingWdvPaise: acc.closingWdvPaise + b.closingWdvPaise,
      }),
      {
        openingWdvPaise: 0,
        additionsPaise: 0,
        disposalsPaise: 0,
        depreciationPaise: 0,
        closingWdvPaise: 0,
      },
    );
  }

  // ─── Additions & Disposals Register ─────────────────────────────────────────

  async additionsDisposalsRegister(wsId: string, firmId: string, dto: AdditionsDisposalsDto) {
    const from = new Date(dto.fromDate);
    const to = new Date(dto.toDate);

    const additions = await this.assetModel
      .find({
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
        purchaseDate: { $gte: from, $lte: to },
      })
      .sort({ purchaseDate: 1 })
      .exec();

    const disposals = await this.assetModel
      .find({
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
        disposalDate: { $gte: from, $lte: to },
      })
      .sort({ disposalDate: 1 })
      .exec();

    return {
      fromDate: dto.fromDate,
      toDate: dto.toDate,
      additions: additions.map((a) => ({
        assetCode: a.assetCode,
        name: a.name,
        categoryName: (a.categorySnapshot as any)?.name,
        purchaseDate: a.purchaseDate,
        costPaise: a.costPaise,
        partyName: a.partyName,
        purchaseBillNumber: a.purchaseBillNumber,
      })),
      disposals: disposals.map((a) => ({
        assetCode: a.assetCode,
        name: a.name,
        disposalDate: a.disposalDate,
        disposalProceedsPaise: a.disposalProceedsPaise,
        // a.nbvPaise is zeroed on disposal; reconstruct NBV-at-disposal from the
        // persisted proceeds and gain/loss (nbv = proceeds - gainLoss).
        nbvAtDisposalPaise: nbvAtDisposalPaise(a.disposalProceedsPaise, a.gainLossOnDisposalPaise),
        gainLossPaise: a.gainLossOnDisposalPaise,
        status: a.status,
      })),
      totals: {
        additionsCount: additions.length,
        additionsCostPaise: additions.reduce((s, a) => s + a.costPaise, 0),
        disposalsCount: disposals.length,
        disposalsProceedsPaise: disposals.reduce((s, a) => s + a.disposalProceedsPaise, 0),
        disposalsGainLossPaise: disposals.reduce((s, a) => s + a.gainLossOnDisposalPaise, 0),
      },
    };
  }
}
