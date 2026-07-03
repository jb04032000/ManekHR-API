import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { FixedAsset } from '../fixed-asset/fixed-asset.schema';
import { Machine } from '../../../machines/schemas/machine.schema';

@Injectable()
export class AssetMachineLinkService {
  private readonly logger = new Logger(AssetMachineLinkService.name);

  constructor(
    @InjectModel(FixedAsset.name) private readonly assetModel: Model<FixedAsset>,
    @InjectModel(Machine.name) private readonly machineModel: Model<Machine>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async linkMachineToAsset(
    wsId: string,
    firmId: string,
    assetId: string,
    machineId: string,
    userId: string,
  ) {
    const asset = await this.assetModel.findOne({
      _id: new Types.ObjectId(assetId),
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    }).exec();
    if (!asset) throw new NotFoundException('Fixed asset not found');

    const machine = await this.machineModel.findOne({
      _id: new Types.ObjectId(machineId),
      workspaceId: new Types.ObjectId(wsId),
      isDeleted: false,
    }).exec();
    if (!machine) throw new NotFoundException('Machine not found');

    // Conflict: asset already linked to a DIFFERENT machine
    if (asset.machineId && asset.machineId.toString() !== machineId) {
      throw new ConflictException({
        message: `Asset already linked to machine ${asset.machineId.toString()}; unlink first`,
        existingMachineId: asset.machineId.toString(),
      });
    }
    // Conflict: machine already linked to a DIFFERENT asset
    if (machine.fixedAssetId && machine.fixedAssetId.toString() !== assetId) {
      throw new ConflictException({
        message: `Machine already linked to asset ${machine.fixedAssetId.toString()}; unlink first`,
        existingAssetId: machine.fixedAssetId.toString(),
      });
    }

    // Idempotent: if already linked to the same pair, return immediately
    if (
      asset.machineId?.toString() === machineId &&
      machine.fixedAssetId?.toString() === assetId
    ) {
      return { asset, machine };
    }

    const session = await this.connection.startSession();
    session.startTransaction();
    try {
      asset.machineId = new Types.ObjectId(machineId);
      (asset.auditLog as any[]).push({
        at: new Date(),
        by: new Types.ObjectId(userId),
        action: 'machine_linked',
        after: { machineId },
      });
      machine.fixedAssetId = new Types.ObjectId(assetId);
      await asset.save({ session });
      await machine.save({ session });
      await session.commitTransaction();
      return { asset, machine };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }

  async unlinkMachine(wsId: string, firmId: string, assetId: string, userId: string) {
    const asset = await this.assetModel.findOne({
      _id: new Types.ObjectId(assetId),
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    }).exec();
    if (!asset) throw new NotFoundException('Fixed asset not found');
    // Idempotent: already unlinked
    if (!asset.machineId) return { ok: true, alreadyUnlinked: true };

    const machine = await this.machineModel.findById(asset.machineId).exec();

    const session = await this.connection.startSession();
    session.startTransaction();
    try {
      const previousMachineId = asset.machineId.toString();
      asset.machineId = undefined;
      (asset.auditLog as any[]).push({
        at: new Date(),
        by: new Types.ObjectId(userId),
        action: 'machine_unlinked',
        before: { machineId: previousMachineId },
      });
      await asset.save({ session });
      if (machine && machine.fixedAssetId && machine.fixedAssetId.toString() === assetId) {
        machine.fixedAssetId = undefined;
        await machine.save({ session });
      }
      await session.commitTransaction();
      return { ok: true };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }
}
