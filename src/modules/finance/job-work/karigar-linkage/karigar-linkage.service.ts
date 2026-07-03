import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { KarigarLinkage, KarigarLinkageDocument } from './karigar-linkage.schema';
import { TeamMember } from '../../../team/schemas/team-member.schema';

@Injectable()
export class KarigarLinkageService {
  constructor(
    @InjectModel(KarigarLinkage.name)
    private readonly linkageModel: Model<KarigarLinkageDocument>,
    @InjectModel(TeamMember.name)
    private readonly teamMemberModel: Model<TeamMember>,
  ) {}

  /**
   * Atomically create one linkage per karigar with wage snapshot from TeamMember.
   * MUST be called inside the voucher post transaction (D-05 — orphan prevention
   * per RESEARCH Pitfall 4). Wage rate is read at call time and persisted as
   * wageRateSnapshotPaise — rate changes on TeamMember do NOT alter past linkages
   * (T-F11-W2-02 immutability).
   */
  async createBulk(args: {
    workspaceId: Types.ObjectId;
    firmId: Types.ObjectId;
    voucher: {
      _id: Types.ObjectId;
      voucherType: 'job_work_in' | 'job_work_out' | 'job_work_invoice' | 'manufacturing_voucher';
      voucherDate: Date;
    };
    karigarIds: Types.ObjectId[];
    machineIds?: Types.ObjectId[];
    shiftId?: Types.ObjectId;
    jobWorkLotId?: Types.ObjectId;
    sourceLineIndex?: number;
    estimatedHours?: number;
    session?: ClientSession;
  }): Promise<KarigarLinkageDocument[]> {
    if (!args.karigarIds || args.karigarIds.length === 0) return [];

    // Snapshot wage rates at call time — isKarigar filter ensures only valid karigars get linkage
    const karigars = await this.teamMemberModel
      .find({ _id: { $in: args.karigarIds }, isKarigar: true })
      .select('karigarDailyRatePaise')
      .session(args.session ?? null)
      .lean();

    const docs = karigars.map((k) => {
      const wageRate = (k as any).karigarDailyRatePaise ?? 0;
      const estHours = args.estimatedHours;
      // If hours known: prorate daily rate by fraction of 8h day; else spread equally
      const estCost = estHours
        ? Math.round((wageRate * estHours) / 8)
        : Math.round(wageRate / Math.max(1, args.karigarIds.length));

      return {
        workspaceId: args.workspaceId,
        firmId: args.firmId,
        sourceVoucherId: args.voucher._id,
        sourceVoucherType: args.voucher.voucherType,
        sourceLineIndex: args.sourceLineIndex,
        voucherDate: args.voucher.voucherDate,
        karigarId: (k as any)._id,
        machineId: args.machineIds?.[0],
        shiftId: args.shiftId,
        wageRateSnapshotPaise: wageRate,
        estimatedHours: estHours,
        estimatedCostPaise: estCost,
        jobWorkLotId: args.jobWorkLotId,
      };
    });

    return this.linkageModel.create(docs, {
      session: args.session,
    }) as Promise<KarigarLinkageDocument[]>;
  }

  async listByVoucher(
    workspaceId: string,
    firmId: string,
    voucherId: string,
  ): Promise<KarigarLinkageDocument[]> {
    return this.linkageModel
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        sourceVoucherId: new Types.ObjectId(voucherId),
      })
      .populate('karigarId', 'name karigarSkillType')
      .exec();
  }

  async listByKarigar(
    workspaceId: string,
    firmId: string,
    karigarId: string,
    dateFrom?: Date,
    dateTo?: Date,
  ): Promise<KarigarLinkageDocument[]> {
    const filter: any = {
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      karigarId: new Types.ObjectId(karigarId),
    };
    if (dateFrom || dateTo) {
      filter.voucherDate = {};
      if (dateFrom) filter.voucherDate.$gte = dateFrom;
      if (dateTo) filter.voucherDate.$lte = dateTo;
    }
    return this.linkageModel.find(filter).sort({ voucherDate: -1 }).exec();
  }
}
