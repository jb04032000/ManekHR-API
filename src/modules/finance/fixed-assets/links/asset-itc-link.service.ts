import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { FixedAsset } from '../fixed-asset/fixed-asset.schema';
import { Machine } from '../../../machines/schemas/machine.schema';
import { CapitalGoodsItcSchedule } from '../../purchases/capital-goods-itc/capital-goods-itc-schedule.schema';
import { PurchaseBill } from '../../purchases/purchase-bill/purchase-bill.schema';

@Injectable()
export class AssetItcLinkService {
  constructor(
    @InjectModel(FixedAsset.name) private readonly assetModel: Model<FixedAsset>,
    @InjectModel(Machine.name) private readonly machineModel: Model<Machine>,
    @InjectModel(CapitalGoodsItcSchedule.name)
    private readonly itcModel: Model<CapitalGoodsItcSchedule>,
    @InjectModel(PurchaseBill.name) private readonly billModel: Model<PurchaseBill>,
  ) {}

  async linkItcSchedule(
    wsId: string,
    firmId: string,
    assetId: string,
    itcScheduleId: string,
    userId: string,
  ) {
    const asset = await this.requireAsset(wsId, firmId, assetId);
    const sched = await this.itcModel
      .findOne({
        _id: new Types.ObjectId(itcScheduleId),
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
      })
      .exec();
    if (!sched) throw new NotFoundException('Capital-goods ITC schedule not found');

    asset.itcScheduleId = sched._id as Types.ObjectId;
    asset.itcClaimedPaise = sched.totalItcPaise;
    (asset.auditLog as any[]).push({
      at: new Date(),
      by: new Types.ObjectId(userId),
      action: 'itc_linked',
      after: { itcScheduleId, itcClaimedPaise: sched.totalItcPaise },
    });
    await asset.save();
    return asset;
  }

  async findScheduleForAsset(wsId: string, firmId: string, assetId: string) {
    const asset = await this.requireAsset(wsId, firmId, assetId);
    if (!asset.itcScheduleId)
      throw new NotFoundException('No ITC schedule linked to this asset');

    const sched = await this.itcModel
      .findOne({
        _id: asset.itcScheduleId,
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
      })
      .exec();
    if (!sched) throw new NotFoundException('Linked ITC schedule no longer exists');
    return sched;
  }

  async findMachineForAsset(wsId: string, firmId: string, assetId: string) {
    const asset = await this.requireAsset(wsId, firmId, assetId);
    if (!asset.machineId) throw new NotFoundException('No machine linked to this asset');

    const machine = await this.machineModel
      .findOne({
        _id: asset.machineId,
        workspaceId: new Types.ObjectId(wsId),
        isDeleted: false,
      })
      .exec();
    if (!machine) throw new NotFoundException('Linked machine no longer exists');
    return machine;
  }

  /**
   * Pre-fill CreateFixedAssetDto from a PurchaseBill line.
   * Caller (web layer) sends the result to POST /fixed-assets after user reviews and adds
   * remaining fields (categoryId, depreciationMethod, etc.).
   *
   * Throws 422 if line.isCapitalGoods=false.
   * Throws 409 if a FixedAsset already references this purchaseBillId.
   */
  async preFillFromPurchaseBill(
    wsId: string,
    firmId: string,
    billId: string,
    lineNo: number,
  ) {
    const bill = await this.billModel
      .findOne({
        _id: new Types.ObjectId(billId),
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
      })
      .exec();
    if (!bill) throw new NotFoundException('Purchase bill not found');

    const line = bill.lineItems?.[lineNo];
    if (!line) throw new NotFoundException(`Line ${lineNo} not found on purchase bill`);

    if (!line.isCapitalGoods) {
      throw new UnprocessableEntityException(
        `Line ${lineNo} is not flagged as capital goods; cannot add to asset register`,
      );
    }

    // Refuse if a FixedAsset already references this purchase bill
    const existingAsset = await this.assetModel
      .findOne({
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        purchaseBillId: bill._id,
        isDeleted: false,
      })
      .exec();
    if (existingAsset) {
      throw new ConflictException({
        message: `Asset already exists for purchase bill ${bill.voucherNumber} (assetCode: ${existingAsset.assetCode}); review existing asset before creating duplicate`,
        existingAssetId: existingAsset._id.toString(),
      });
    }

    // Optional: find existing CapitalGoodsItcSchedule for this bill+line
    const sched = await this.itcModel
      .findOne({
        sourceBillId: bill._id,
        sourceLineNo: lineNo,
      })
      .exec();

    // Use cost-net-of-tax (taxable value); gross cost available as fallback
    const grossCostPaise =
      (line.taxableValuePaise || 0) +
      (line.cgstPaise || 0) +
      (line.sgstPaise || 0) +
      (line.igstPaise || 0);
    const costPaise = line.taxableValuePaise || grossCostPaise;

    // Extract partyName from partySnapshot (PurchaseBill stores party as a snapshot object)
    const partyName: string | undefined =
      (bill.partySnapshot as any)?.name || undefined;

    return {
      name: line.itemName || `Asset from PB ${bill.voucherNumber} line ${lineNo + 1}`,
      financialYear: bill.financialYear,
      purchaseDate: bill.voucherDate,
      purchaseBillId: bill._id.toString(),
      purchaseBillNumber: bill.voucherNumber,
      partyId: bill.partyId?.toString(),
      partyName,
      costPaise,
      itcScheduleId: sched?._id.toString(),
      itcClaimedPaise: sched?.totalItcPaise || 0,
      // categoryId, depreciationMethod, usefulLifeYears, salvageValuePaise
      // left for user to fill in before submitting to POST /fixed-assets
    };
  }

  private async requireAsset(wsId: string, firmId: string, assetId: string) {
    const asset = await this.assetModel
      .findOne({
        _id: new Types.ObjectId(assetId),
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .exec();
    if (!asset) throw new NotFoundException('Fixed asset not found');
    return asset;
  }
}
