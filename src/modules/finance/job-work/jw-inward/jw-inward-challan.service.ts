import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import {
  JobWorkInwardChallan,
  JobWorkInwardChallanDocument,
} from './jw-inward-challan.schema';
import { Firm } from '../../firms/firm.schema';
import { VoucherSeriesService } from '../../voucher-series/voucher-series.service';
import { JwLotService } from '../jw-lot/jw-lot.service';
import { KarigarLinkageService } from '../karigar-linkage/karigar-linkage.service';
import { CreateJwInwardDto } from './dto/create-jw-inward.dto';
import { UpdateJwInwardDto } from './dto/update-jw-inward.dto';
import { ListJwInwardDto } from './dto/list-jw-inward.dto';
import { FyLockService } from '../../fiscal-year/fy-lock.service';

@Injectable()
export class JwInwardChallanService {
  constructor(
    @InjectConnection() private readonly conn: Connection,
    @InjectModel(JobWorkInwardChallan.name)
    private readonly jwiModel: Model<JobWorkInwardChallanDocument>,
    @InjectModel(Firm.name)
    private readonly firmModel: Model<Firm>,
    private readonly voucherSeriesService: VoucherSeriesService,
    private readonly jwLotService: JwLotService,
    private readonly karigarLinkageService: KarigarLinkageService,
    private readonly fyLock: FyLockService,
  ) {}

  async create(
    wsId: string,
    firmId: string,
    userId: string,
    dto: CreateJwInwardDto,
  ): Promise<JobWorkInwardChallanDocument> {
    // F-15 Plan 03: FY-lock guard
    await this.fyLock.assertOpen(wsId, firmId, new Date(dto.voucherDate as any));

    const doc = new this.jwiModel({
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      voucherType: 'job_work_in',
      voucherNumber: '',
      voucherDate: dto.voucherDate,
      status: 'draft',
      partyId: new Types.ObjectId(dto.partyId),
      vehicleNo: dto.vehicleNo,
      transporterName: dto.transporterName,
      transporterGSTIN: dto.transporterGSTIN,
      lrNo: dto.lrNo,
      lines: dto.lines.map((l, i) => ({
        lineNo: i + 1,
        itemDescription: l.itemDescription,
        hsnCode: l.hsnCode,
        qty: l.qty,
        unit: l.unit,
        vehicleNo: l.vehicleNo,
        karigarIds: (l.karigarIds ?? []).map((id) => new Types.ObjectId(id)),
        machineIds: (l.machineIds ?? []).map((id) => new Types.ObjectId(id)),
        narration: l.narration,
      })),
      karigarIds: (dto.karigarIds ?? []).map((id) => new Types.ObjectId(id)),
      machineIds: (dto.machineIds ?? []).map((id) => new Types.ObjectId(id)),
      shiftId: dto.shiftId ? new Types.ObjectId(dto.shiftId) : undefined,
      narration: dto.narration,
      isDeleted: false,
      createdBy: new Types.ObjectId(userId),
    });
    return doc.save();
  }

  async list(wsId: string, firmId: string, q: ListJwInwardDto) {
    const filter: any = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };
    if (q.partyId) filter.partyId = new Types.ObjectId(q.partyId);
    if (q.status) filter.status = q.status;
    if (q.dateFrom || q.dateTo) {
      filter.voucherDate = {};
      if (q.dateFrom) filter.voucherDate.$gte = q.dateFrom;
      if (q.dateTo) filter.voucherDate.$lte = q.dateTo;
    }
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const [items, total] = await Promise.all([
      this.jwiModel
        .find(filter)
        .sort({ voucherDate: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .populate('partyId', 'name gstin')
        .exec(),
      this.jwiModel.countDocuments(filter),
    ]);
    return { items, total, page, pageSize };
  }

  async get(
    wsId: string,
    firmId: string,
    id: string,
  ): Promise<JobWorkInwardChallanDocument> {
    const doc = await this.jwiModel
      .findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .populate('partyId', 'name gstin address')
      .exec();
    if (!doc) throw new NotFoundException('JWI challan not found');
    return doc;
  }

  async update(
    wsId: string,
    firmId: string,
    id: string,
    dto: UpdateJwInwardDto,
  ): Promise<JobWorkInwardChallanDocument> {
    const doc = await this.get(wsId, firmId, id);
    if (doc.status !== 'draft')
      throw new BadRequestException('Only draft JWI can be edited');
    // F-15 Plan 03: FY-lock guard against BOTH old and new voucherDate
    await this.fyLock.assertOpen(wsId, firmId, doc.voucherDate);
    if (dto.voucherDate) {
      await this.fyLock.assertOpen(wsId, firmId, new Date(dto.voucherDate as any));
    }
    if (dto.lines) {
      (doc as any).lines = dto.lines.map((l, i) => ({
        lineNo: i + 1,
        itemDescription: l.itemDescription,
        hsnCode: l.hsnCode,
        qty: l.qty,
        unit: l.unit,
        vehicleNo: l.vehicleNo,
        karigarIds: (l.karigarIds ?? []).map((id) => new Types.ObjectId(id)),
        machineIds: (l.machineIds ?? []).map((id) => new Types.ObjectId(id)),
        narration: l.narration,
      }));
    }
    if (dto.partyId !== undefined)
      doc.partyId = new Types.ObjectId(dto.partyId) as any;
    if (dto.voucherDate !== undefined) doc.voucherDate = dto.voucherDate;
    if (dto.vehicleNo !== undefined) doc.vehicleNo = dto.vehicleNo;
    if (dto.transporterName !== undefined)
      doc.transporterName = dto.transporterName;
    if (dto.transporterGSTIN !== undefined)
      doc.transporterGSTIN = dto.transporterGSTIN;
    if (dto.lrNo !== undefined) doc.lrNo = dto.lrNo;
    if (dto.narration !== undefined) doc.narration = dto.narration;
    if (dto.karigarIds !== undefined)
      (doc as any).karigarIds = dto.karigarIds.map(
        (id) => new Types.ObjectId(id),
      );
    if (dto.machineIds !== undefined)
      (doc as any).machineIds = dto.machineIds.map(
        (id) => new Types.ObjectId(id),
      );
    if (dto.shiftId !== undefined)
      (doc as any).shiftId = dto.shiftId
        ? new Types.ObjectId(dto.shiftId)
        : undefined;
    return doc.save();
  }

  /**
   * D-02: Post creates one JobWorkLot per line atomically inside a Mongoose session.
   * Assigns voucher number, locks status to 'posted'.
   */
  async post(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
  ): Promise<JobWorkInwardChallanDocument> {
    // F-15 Plan 03: FY-lock guard — pre-check before opening transaction
    {
      const pre = await this.jwiModel
        .findOne({
          _id: new Types.ObjectId(id),
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
        })
        .lean();
      if (pre?.voucherDate) {
        await this.fyLock.assertOpen(wsId, firmId, pre.voucherDate);
      }
    }

    const session = await this.conn.startSession();
    session.startTransaction();
    try {
      const challan = await this.jwiModel
        .findOne({
          _id: new Types.ObjectId(id),
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          status: 'draft',
          isDeleted: false,
        })
        .session(session);
      if (!challan) throw new NotFoundException('JWI not found or not in draft');
      if (!challan.lines || challan.lines.length === 0) {
        throw new BadRequestException('Cannot post empty challan');
      }

      // Resolve firm for FY determination
      const firm = await this.firmModel.findById(challan.firmId).session(session);
      if (!firm) throw new NotFoundException('Firm not found');
      const fy = this.voucherSeriesService.getFYForDate(
        challan.voucherDate,
        (firm as any).fyStartMonth ?? 4,
      );

      // Generate voucher number from VoucherSeries
      challan.voucherNumber = await this.voucherSeriesService.generateNextNumber(
        String(challan.firmId),
        'job_work_in',
        fy,
      );

      // Resolve default godown for the firm (isDefault: true guard)
      const Godown = this.conn.model('Godown');
      const mainGodown = await Godown.findOne({
        workspaceId: challan.workspaceId,
        firmId: challan.firmId,
        isDefault: true,
        isDeleted: { $ne: true },
      })
        .session(session)
        .lean();
      if (!mainGodown)
        throw new BadRequestException('No default godown configured for firm');

      // Create one JobWorkLot per line (atomic, inside session)
      const lots = await this.jwLotService.createBulkFromInwardLines({
        workspaceId: challan.workspaceId as Types.ObjectId,
        firmId: challan.firmId as Types.ObjectId,
        principalPartyId: challan.partyId as Types.ObjectId,
        inwardChallanId: challan._id as Types.ObjectId,
        inwardDate: challan.voucherDate,
        godownId: (mainGodown as any)._id,
        lines: challan.lines.map((l) => ({
          itemDescription: l.itemDescription,
          hsnCode: l.hsnCode,
          unit: l.unit,
          qty: l.qty,
        })),
        session,
      });

      // Backfill jobWorkLotId on each challan line
      challan.lines.forEach((line, i) => {
        (line as any).jobWorkLotId = lots[i]._id;
      });
      challan.status = 'posted';
      await challan.save({ session });

      // Optional: create KarigarLinkage if header karigars are assigned
      if (challan.karigarIds && challan.karigarIds.length > 0) {
        await this.karigarLinkageService.createBulk({
          workspaceId: challan.workspaceId as Types.ObjectId,
          firmId: challan.firmId as Types.ObjectId,
          voucher: {
            _id: challan._id as Types.ObjectId,
            voucherType: 'job_work_in',
            voucherDate: challan.voucherDate,
          },
          karigarIds: challan.karigarIds as Types.ObjectId[],
          machineIds:
            (challan.machineIds as Types.ObjectId[] | undefined) ?? undefined,
          shiftId: (challan.shiftId as Types.ObjectId | undefined) ?? undefined,
          session,
        });
      }

      await session.commitTransaction();
      return challan;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }

  async cancel(
    wsId: string,
    firmId: string,
    id: string,
  ): Promise<JobWorkInwardChallanDocument> {
    const doc = await this.get(wsId, firmId, id);
    if (doc.status !== 'draft')
      throw new BadRequestException('Only draft JWI can be cancelled');
    // F-15 Plan 03: FY-lock guard
    await this.fyLock.assertOpen(wsId, firmId, doc.voucherDate);
    doc.isDeleted = true;
    return doc.save();
  }
}
