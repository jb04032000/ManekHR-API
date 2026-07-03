import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { FixedAsset } from '../fixed-asset/fixed-asset.schema';
import {
  DepreciationMathService,
  DepreciationInput,
} from '../depreciation/depreciation-math.service';
import { LedgerPostingService } from '../../sales/ledger-posting/ledger-posting.service';
import { ItcReversalService, ItcReversalResult } from './itc-reversal.service';
import { DisposeAssetDto } from './dto/dispose-asset.dto';
import { PreviewDisposalDto } from './dto/preview-disposal.dto';
import { TransferAssetDto } from './dto/transfer-asset.dto';

function formatYearMonth(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export interface DisposalPreview {
  assetCode: string;
  costPaise: number;
  accumulatedDepreciationPaise: number;
  nbvAtDisposalPaise: number;
  partialMonthDepreciationPaise: number;
  disposalProceedsPaise: number;
  gainLossPaise: number; // positive = gain, negative = loss
  itcReversal: ItcReversalResult;
}

@Injectable()
export class DisposalService {
  private readonly logger = new Logger(DisposalService.name);

  constructor(
    @InjectModel(FixedAsset.name) private readonly assetModel: Model<FixedAsset>,
    @InjectConnection() private readonly connection: Connection,
    private readonly math: DepreciationMathService,
    private readonly ledgerPosting: LedgerPostingService,
    private readonly itcReversal: ItcReversalService,
  ) {}

  // ─── Preview ────────────────────────────────────────────────────────────────

  async preview(
    wsId: string,
    firmId: string,
    assetId: string,
    dto: PreviewDisposalDto,
  ): Promise<DisposalPreview> {
    const asset = await this.requireActiveAsset(wsId, firmId, assetId);
    const disposalDate = new Date(dto.disposalDate);
    const partial = this.computePartialMonthDepreciation(asset, disposalDate);
    const newAccumulated = asset.accumulatedDepreciationPaise + partial;
    const nbv = asset.costPaise - newAccumulated;
    const gainLoss = dto.disposalProceedsPaise - nbv;
    const itc = this.itcReversal.computeReversal(
      asset.itcClaimedPaise || 0,
      asset.purchaseDate,
      disposalDate,
    );
    return {
      assetCode: asset.assetCode,
      costPaise: asset.costPaise,
      accumulatedDepreciationPaise: newAccumulated,
      nbvAtDisposalPaise: nbv,
      partialMonthDepreciationPaise: partial,
      disposalProceedsPaise: dto.disposalProceedsPaise,
      gainLossPaise: gainLoss,
      itcReversal: itc,
    };
  }

  // ─── Dispose (sale / scrap / writeoff) ──────────────────────────────────────

  async dispose(
    wsId: string,
    firmId: string,
    assetId: string,
    dto: DisposeAssetDto,
    userId: string,
  ) {
    const asset = await this.requireActiveAsset(wsId, firmId, assetId);
    const disposalDate = new Date(dto.disposalDate);

    // ITC reversal acknowledgement gate — refuse unless user has confirmed the reversal amount
    const itc = this.itcReversal.computeReversal(
      asset.itcClaimedPaise || 0,
      asset.purchaseDate,
      disposalDate,
    );
    if (itc.applicable && !dto.acknowledgeItcReversal) {
      throw new UnprocessableEntityException({
        message: `GST Rule 44(6) ITC reversal of ${itc.reversalPaise} paise is required. Set acknowledgeItcReversal=true to proceed.`,
        itcReversal: itc,
      });
    }

    // Business rule: scrapping requires zero proceeds
    if (dto.disposalType === 'scrap' && dto.disposalProceedsPaise !== 0) {
      throw new BadRequestException(
        'Scrapping (disposalType=scrap) requires disposalProceedsPaise=0',
      );
    }

    // Proceeds > 0 requires a cash/bank account to debit
    if (dto.disposalProceedsPaise > 0 && !dto.cashOrBankAccountCode) {
      throw new BadRequestException(
        'cashOrBankAccountCode required when disposalProceedsPaise > 0',
      );
    }

    const session = await this.connection.startSession();
    session.startTransaction();
    try {
      // ── Step 1: partial-month depreciation catch-up (race-condition guard is inside helper) ──
      const partial = this.computePartialMonthDepreciation(asset, disposalDate);
      if (partial > 0) {
        const partialEntry = await this.ledgerPosting.postDepreciation(
          asset,
          partial,
          formatYearMonth(disposalDate),
          asset._id, // use asset _id as runId for partial-month entries
          disposalDate,
          { userId, session },
        );
        asset.accumulatedDepreciationPaise += partial;
        asset.nbvPaise = asset.costPaise - asset.accumulatedDepreciationPaise;
        asset.lastDepreciationMonth = formatYearMonth(disposalDate);
        asset.auditLog.push({
          at: new Date(),
          by: new Types.ObjectId(userId),
          action: 'partial_month_depreciation',
          after: {
            partialPaise: partial,
            ledgerEntryId: partialEntry._id.toString(),
          },
        } as any);
      }

      // ── Step 2: post disposal journal entry ────────────────────────────────
      const nbvAtDisposal = asset.costPaise - asset.accumulatedDepreciationPaise;
      const gainLoss = dto.disposalProceedsPaise - nbvAtDisposal;

      const disposalEntry = await this.ledgerPosting.postAssetDisposal(asset, {
        disposalProceedsPaise: dto.disposalProceedsPaise,
        cashOrBankAccountCode: dto.cashOrBankAccountCode || null,
        disposalDate,
        userId,
        narration: dto.narration,
        session,
      });

      // ── Step 3: update asset document state ────────────────────────────────
      const newStatus: string = dto.disposalType === 'scrap' ? 'scrapped' : 'disposed';
      asset.status = newStatus;
      asset.disposalDate = disposalDate;
      asset.disposalProceedsPaise = dto.disposalProceedsPaise;
      asset.gainLossOnDisposalPaise = gainLoss;
      asset.disposalNarration = dto.narration;
      asset.disposalVoucherId = disposalEntry._id;
      // After disposal: accumulated = full cost, NBV = 0
      asset.accumulatedDepreciationPaise = asset.costPaise;
      asset.nbvPaise = 0;
      asset.isFullyDepreciated = true;

      asset.auditLog.push({
        at: new Date(),
        by: new Types.ObjectId(userId),
        action: dto.disposalType,
        after: {
          disposalDate,
          disposalProceedsPaise: dto.disposalProceedsPaise,
          gainLossPaise: gainLoss,
          ledgerEntryId: disposalEntry._id.toString(),
          itcReversalPaise: itc.applicable ? itc.reversalPaise : 0,
        },
      } as any);

      await asset.save({ session });
      await session.commitTransaction();

      this.logger.log(
        `Asset ${asset.assetCode} disposed (${dto.disposalType}): NBV=${nbvAtDisposal}, proceeds=${dto.disposalProceedsPaise}, gainLoss=${gainLoss}`,
      );

      return { asset, disposalEntry, itcReversal: itc };
    } catch (err) {
      await session.abortTransaction();
      this.logger.error(`Disposal failed for asset ${assetId}: ${err}`);
      throw err;
    } finally {
      session.endSession();
    }
  }

  // ─── Transfer (location / custodian change — no financial impact) ────────────

  async transfer(
    wsId: string,
    firmId: string,
    assetId: string,
    dto: TransferAssetDto,
    userId: string,
  ) {
    const asset = await this.requireActiveAsset(wsId, firmId, assetId);

    if (!dto.locationId && !dto.custodianMemberId) {
      throw new BadRequestException('At least one of locationId or custodianMemberId is required');
    }

    const before = {
      locationId: asset.locationId?.toString(),
      custodianMemberId: asset.custodianMemberId?.toString(),
    };

    if (dto.locationId) asset.locationId = new Types.ObjectId(dto.locationId);
    if (dto.custodianMemberId) asset.custodianMemberId = new Types.ObjectId(dto.custodianMemberId);

    asset.auditLog.push({
      at: new Date(),
      by: new Types.ObjectId(userId),
      action: 'transferred',
      before,
      after: {
        locationId: asset.locationId?.toString(),
        custodianMemberId: asset.custodianMemberId?.toString(),
        narration: dto.narration,
      },
    } as any);

    await asset.save();
    return asset;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private async requireActiveAsset(wsId: string, firmId: string, assetId: string) {
    const asset = await this.assetModel
      .findOne({
        _id: new Types.ObjectId(assetId),
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .exec();

    if (!asset) throw new NotFoundException('Fixed asset not found');

    if (asset.status !== 'active') {
      throw new UnprocessableEntityException(
        `Asset is already ${asset.status}; only active assets can be disposed or transferred`,
      );
    }

    return asset;
  }

  /**
   * Pro-rata depreciation from the start of the disposal month to the disposal date.
   * Returns 0 if the cron has already posted depreciation for the disposal month
   * (race-condition guard: lastDepreciationMonth >= disposal month).
   */
  private computePartialMonthDepreciation(asset: any, disposalDate: Date): number {
    const disposalMonth = formatYearMonth(disposalDate);

    // Race-condition guard: cron already covered this month
    if (asset.lastDepreciationMonth && asset.lastDepreciationMonth >= disposalMonth) {
      return 0;
    }

    if (asset.isFullyDepreciated) return 0;

    const cat = (asset.categorySnapshot || {}) as Record<string, any>;
    const periodStart = new Date(disposalDate.getFullYear(), disposalDate.getMonth(), 1);

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

    const out = this.math.computeForPeriod(input, periodStart, disposalDate);
    return out.amountPaise;
  }
}
