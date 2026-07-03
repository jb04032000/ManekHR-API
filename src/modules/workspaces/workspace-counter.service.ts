import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { WorkspaceCounter } from './schemas/workspace-counter.schema';

@Injectable()
export class WorkspaceCounterService {
  constructor(
    @InjectModel(WorkspaceCounter.name)
    private readonly counterModel: Model<WorkspaceCounter>,
  ) {}

  private toObjectId(workspaceId: string | Types.ObjectId): Types.ObjectId {
    return typeof workspaceId === 'string' ? new Types.ObjectId(workspaceId) : workspaceId;
  }

  /**
   * Atomically reserve the next sequence number for this workspace.
   * Creates the counter document on first call via upsert.
   */
  async reserveNextCode(workspaceId: string | Types.ObjectId): Promise<number> {
    const wsId = this.toObjectId(workspaceId);
    const doc = await this.counterModel
      .findOneAndUpdate(
        { workspaceId: wsId },
        { $inc: { teamMemberCodeCounter: 1 } },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        },
      )
      .exec();
    return doc.teamMemberCodeCounter;
  }

  /**
   * Returns the next value that would be reserved, without mutating state.
   * Used for preview UIs and pre-flight checks.
   */
  async peekNextCode(workspaceId: string | Types.ObjectId): Promise<number> {
    const current = await this.getCurrent(workspaceId);
    return current + 1;
  }

  /**
   * Returns the last-reserved counter value (0 if no counter exists yet).
   */
  async getCurrent(workspaceId: string | Types.ObjectId): Promise<number> {
    const wsId = this.toObjectId(workspaceId);
    const doc = await this.counterModel.findOne({ workspaceId: wsId }).exec();
    return doc?.teamMemberCodeCounter ?? 0;
  }

  /**
   * Force the counter to a specific value (upserts the doc if needed).
   * Used by the backfill endpoint and by settings updates that change
   * the starting number.
   */
  async setCounter(workspaceId: string | Types.ObjectId, value: number): Promise<void> {
    const wsId = this.toObjectId(workspaceId);
    await this.counterModel
      .findOneAndUpdate(
        { workspaceId: wsId },
        { $set: { teamMemberCodeCounter: value } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
  }

  async reserveNextMachineCode(workspaceId: string | Types.ObjectId): Promise<number> {
    const wsId = this.toObjectId(workspaceId);
    const doc = await this.counterModel
      .findOneAndUpdate(
        { workspaceId: wsId },
        { $inc: { machineCodeCounter: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
    return doc.machineCodeCounter;
  }

  async peekNextMachineCode(workspaceId: string | Types.ObjectId): Promise<number> {
    const wsId = this.toObjectId(workspaceId);
    const doc = await this.counterModel.findOne({ workspaceId: wsId }).exec();
    return (doc?.machineCodeCounter ?? 0) + 1;
  }

  async reserveNextLocationCode(workspaceId: string | Types.ObjectId): Promise<number> {
    const wsId = this.toObjectId(workspaceId);
    const doc = await this.counterModel
      .findOneAndUpdate(
        { workspaceId: wsId },
        { $inc: { locationCodeCounter: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
    return doc.locationCodeCounter;
  }

  async peekNextLocationCode(workspaceId: string | Types.ObjectId): Promise<number> {
    const wsId = this.toObjectId(workspaceId);
    const doc = await this.counterModel.findOne({ workspaceId: wsId }).exec();
    return (doc?.locationCodeCounter ?? 0) + 1;
  }

  async reserveNextGodownCode(workspaceId: string | Types.ObjectId): Promise<number> {
    const wsId = this.toObjectId(workspaceId);
    const counter = await this.counterModel
      .findOneAndUpdate(
        { workspaceId: wsId },
        { $inc: { godownCodeCounter: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
    return counter.godownCodeCounter;
  }

  async reserveNextProductionLogCode(workspaceId: string | Types.ObjectId): Promise<number> {
    const wsId = this.toObjectId(workspaceId);
    const doc = await this.counterModel
      .findOneAndUpdate(
        { workspaceId: wsId },
        { $inc: { productionLogCounter: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
    return doc.productionLogCounter;
  }

  async peekNextProductionLogCode(workspaceId: string | Types.ObjectId): Promise<number> {
    const wsId = this.toObjectId(workspaceId);
    const doc = await this.counterModel.findOne({ workspaceId: wsId }).exec();
    return (doc?.productionLogCounter ?? 0) + 1;
  }

  async reserveNextDowntimeCode(workspaceId: string | Types.ObjectId): Promise<number> {
    const wsId = this.toObjectId(workspaceId);
    const doc = await this.counterModel
      .findOneAndUpdate(
        { workspaceId: wsId },
        { $inc: { downtimeCounter: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
    return doc.downtimeCounter;
  }

  async peekNextDowntimeCode(workspaceId: string | Types.ObjectId): Promise<number> {
    const wsId = this.toObjectId(workspaceId);
    const doc = await this.counterModel.findOne({ workspaceId: wsId }).exec();
    return (doc?.downtimeCounter ?? 0) + 1;
  }

  async reserveNextMaintenanceScheduleCode(workspaceId: string | Types.ObjectId): Promise<number> {
    const wsId = this.toObjectId(workspaceId);
    const doc = await this.counterModel
      .findOneAndUpdate(
        { workspaceId: wsId },
        { $inc: { maintenanceScheduleCounter: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
    return doc.maintenanceScheduleCounter;
  }

  async peekNextMaintenanceScheduleCode(workspaceId: string | Types.ObjectId): Promise<number> {
    const wsId = this.toObjectId(workspaceId);
    const doc = await this.counterModel.findOne({ workspaceId: wsId }).exec();
    return (doc?.maintenanceScheduleCounter ?? 0) + 1;
  }

  async reserveNextServiceLogCode(workspaceId: string | Types.ObjectId): Promise<number> {
    const wsId = this.toObjectId(workspaceId);
    const doc = await this.counterModel
      .findOneAndUpdate(
        { workspaceId: wsId },
        { $inc: { serviceLogCounter: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
    return doc.serviceLogCounter;
  }

  async peekNextServiceLogCode(workspaceId: string | Types.ObjectId): Promise<number> {
    const wsId = this.toObjectId(workspaceId);
    const doc = await this.counterModel.findOne({ workspaceId: wsId }).exec();
    return (doc?.serviceLogCounter ?? 0) + 1;
  }

  // Shop Floor work orders — atomic WO-NNN reservation (mirrors downtime).
  async reserveNextWorkOrderCode(workspaceId: string | Types.ObjectId): Promise<number> {
    const wsId = this.toObjectId(workspaceId);
    const doc = await this.counterModel
      .findOneAndUpdate(
        { workspaceId: wsId },
        { $inc: { workOrderCounter: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
    return doc.workOrderCounter;
  }

  async peekNextWorkOrderCode(workspaceId: string | Types.ObjectId): Promise<number> {
    const wsId = this.toObjectId(workspaceId);
    const doc = await this.counterModel.findOne({ workspaceId: wsId }).exec();
    return (doc?.workOrderCounter ?? 0) + 1;
  }
}
