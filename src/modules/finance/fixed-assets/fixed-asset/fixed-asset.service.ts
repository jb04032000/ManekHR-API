import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { FixedAsset } from './fixed-asset.schema';
import { AssetCategory } from '../asset-category/asset-category.schema';
import { CreateFixedAssetDto } from './dto/create-fixed-asset.dto';
import { UpdateFixedAssetDto } from './dto/update-fixed-asset.dto';
import { ListFixedAssetsDto } from './dto/list-fixed-assets.dto';
import { VoucherSeriesService } from '../../voucher-series/voucher-series.service';
import { firstDepreciationMonth } from './acquisition-depreciation.util';

@Injectable()
export class FixedAssetService {
  constructor(
    @InjectModel(FixedAsset.name) private readonly model: Model<FixedAsset>,
    @InjectModel(AssetCategory.name) private readonly categoryModel: Model<AssetCategory>,
    private readonly voucherSeries: VoucherSeriesService,
  ) {}

  async list(wsId: string, firmId: string, dto: ListFixedAssetsDto) {
    const filter: Record<string, any> = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };
    if (dto.categoryId) filter.categoryId = new Types.ObjectId(dto.categoryId);
    if (dto.status) filter.status = dto.status;
    if (dto.financialYear) filter.financialYear = dto.financialYear;
    if (dto.fromDate || dto.toDate) {
      filter.purchaseDate = {};
      if (dto.fromDate) filter.purchaseDate.$gte = new Date(dto.fromDate);
      if (dto.toDate) filter.purchaseDate.$lte = new Date(dto.toDate);
    }
    if (dto.search) {
      const re = new RegExp(dto.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: re }, { assetCode: re }, { serialNumber: re }];
    }
    const page = dto.page || 1;
    const limit = dto.limit || 50;
    const [items, total] = await Promise.all([
      this.model
        .find(filter)
        .sort({ purchaseDate: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.model.countDocuments(filter),
    ]);
    return { items, total, page, limit };
  }

  async findOne(wsId: string, firmId: string, id: string) {
    const doc = await this.model
      .findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .exec();
    if (!doc) throw new NotFoundException('Fixed asset not found');
    return doc;
  }

  async create(wsId: string, firmId: string, dto: CreateFixedAssetDto, userId: string) {
    const category = await this.categoryModel
      .findOne({
        _id: new Types.ObjectId(dto.categoryId),
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .exec();
    if (!category) throw new NotFoundException('Asset category not found');

    const purchaseDate = new Date(dto.purchaseDate);
    // FY is server-authoritative: an asset belongs to the FY of its purchase date
    // (statutory April FY). Never trust a client-supplied financialYear.
    const financialYear = this.voucherSeries.getFYForDate(purchaseDate);
    const salvagePct = category.residualValuePct ?? 0.05;
    const salvageValuePaise = dto.salvageValuePaise ?? Math.round(dto.costPaise * salvagePct);
    if (salvageValuePaise >= dto.costPaise) {
      throw new UnprocessableEntityException('Salvage value must be less than cost');
    }
    const depreciableAmountPaise = dto.costPaise - salvageValuePaise;

    // Auto-generate asset code via VoucherSeriesService if not provided
    // Uses generateNextNumber(firmId, voucherType, financialYear)
    const assetCode =
      dto.assetCode ||
      (await this.voucherSeries.generateNextNumber(firmId, 'fixed_asset_addition', financialYear));

    const depreciationMethod = dto.depreciationMethod || category.depreciationMethod;
    const usefulLifeYears = dto.usefulLifeYears || category.usefulLifeYears;

    const created = await this.model.create({
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      assetCode,
      name: dto.name,
      description: dto.description,
      categoryId: category._id,
      categorySnapshot: {
        name: category.name,
        accountCode: category.accountCode,
        depreciationMethod: category.depreciationMethod,
        slmRate: category.slmRate,
        wdvRate: category.wdvRate,
        usefulLifeYears: category.usefulLifeYears,
        residualValuePct: category.residualValuePct,
        isNesd: category.isNesd,
        itActBlock: category.itActBlock,
        itActRate: category.itActRate,
      },
      financialYear,
      purchaseDate,
      installationDate: dto.installationDate ? new Date(dto.installationDate) : undefined,
      purchaseBillId: dto.purchaseBillId ? new Types.ObjectId(dto.purchaseBillId) : undefined,
      purchaseBillNumber: dto.purchaseBillNumber,
      partyId: dto.partyId ? new Types.ObjectId(dto.partyId) : undefined,
      partyName: dto.partyName,
      costPaise: dto.costPaise,
      salvageValuePaise,
      depreciableAmountPaise,
      usefulLifeYears,
      depreciationMethod,
      slmRateOverride: dto.slmRateOverride,
      wdvRateOverride: dto.wdvRateOverride,
      depreciationFrequency: dto.depreciationFrequency || 'monthly',
      shiftType: dto.shiftType || 'single',
      openingNbvPaise: dto.costPaise,
      accumulatedDepreciationPaise: 0,
      nbvPaise: dto.costPaise,
      // Companies Act Sch-II: depreciate pro-rata from the acquisition month
      // itself (the math service pro-rates the partial first month); cursoring to
      // purchaseDate + 1 month skipped it and under-depreciated year one.
      nextDepreciationMonth: firstDepreciationMonth(purchaseDate),
      locationId: dto.locationId ? new Types.ObjectId(dto.locationId) : undefined,
      custodianMemberId: dto.custodianMemberId
        ? new Types.ObjectId(dto.custodianMemberId)
        : undefined,
      serialNumber: dto.serialNumber,
      itcScheduleId: dto.itcScheduleId ? new Types.ObjectId(dto.itcScheduleId) : undefined,
      itcClaimedPaise: dto.itcClaimedPaise || 0,
      machineId: dto.machineId ? new Types.ObjectId(dto.machineId) : undefined,
      tags: dto.tags || [],
      notes: dto.notes,
      status: 'active',
      isFullyDepreciated: false,
      isDeleted: false,
      createdBy: new Types.ObjectId(userId),
      auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'created' }],
    });

    // Generate qrCodeData now that _id exists
    created.qrCodeData = `FA:${assetCode}:${created._id.toString()}`;
    await created.save();
    return created;
  }

  async update(wsId: string, firmId: string, id: string, dto: UpdateFixedAssetDto, userId: string) {
    const doc = await this.findOne(wsId, firmId, id);
    const lockedFields: Array<keyof UpdateFixedAssetDto> = [
      'costPaise',
      'depreciationMethod',
      'categoryId',
      'purchaseDate',
    ];
    const tryingToEditLocked = lockedFields.some((k) => dto[k] !== undefined);
    if (tryingToEditLocked && (doc.status !== 'active' || doc.accumulatedDepreciationPaise > 0)) {
      throw new UnprocessableEntityException(
        'Cannot edit cost/method/category/purchaseDate after depreciation has been posted or asset disposed',
      );
    }
    const before = { ...doc.toObject() };
    Object.assign(doc, {
      ...dto,
      categoryId: dto.categoryId ? new Types.ObjectId(dto.categoryId) : doc.categoryId,
      partyId: dto.partyId ? new Types.ObjectId(dto.partyId) : doc.partyId,
      locationId: dto.locationId ? new Types.ObjectId(dto.locationId) : doc.locationId,
      custodianMemberId: dto.custodianMemberId
        ? new Types.ObjectId(dto.custodianMemberId)
        : doc.custodianMemberId,
      machineId: dto.machineId ? new Types.ObjectId(dto.machineId) : doc.machineId,
      updatedBy: new Types.ObjectId(userId),
    });
    // Salvage value is editable (not a locked field); re-derive the SLM
    // depreciable base so later runs depreciate cost-minus-current-salvage and
    // not a stale amount captured at creation.
    doc.depreciableAmountPaise = doc.costPaise - (doc.salvageValuePaise ?? 0);
    doc.auditLog.push({
      at: new Date(),
      by: new Types.ObjectId(userId),
      action: 'updated',
      before,
      after: { ...doc.toObject() },
    });
    await doc.save();
    return doc;
  }

  async softDelete(wsId: string, firmId: string, id: string, userId: string) {
    const doc = await this.findOne(wsId, firmId, id);
    if (doc.status === 'active' && doc.accumulatedDepreciationPaise > 0) {
      throw new UnprocessableEntityException(
        'Active asset with posted depreciation cannot be deleted; dispose or scrap instead',
      );
    }
    doc.isDeleted = true;
    doc.deletedAt = new Date();
    doc.auditLog.push({ at: new Date(), by: new Types.ObjectId(userId), action: 'deleted' });
    await doc.save();
    return { ok: true };
  }

  /** Mark asset as physically verified — used by Wave 5 UI and Wave 7 mobile. */
  async markVerified(wsId: string, firmId: string, id: string, userId: string) {
    const doc = await this.findOne(wsId, firmId, id);
    doc.lastVerifiedAt = new Date();
    doc.lastVerifiedBy = new Types.ObjectId(userId);
    doc.auditLog.push({ at: new Date(), by: new Types.ObjectId(userId), action: 'verified' });
    await doc.save();
    return doc;
  }
}
