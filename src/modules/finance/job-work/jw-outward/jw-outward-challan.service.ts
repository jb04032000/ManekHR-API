import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import {
  JobWorkOutwardChallan,
  JobWorkOutwardChallanDocument,
} from './jw-outward-challan.schema';
import {
  JobWorkInwardChallan,
  JobWorkInwardChallanDocument,
} from '../jw-inward/jw-inward-challan.schema';
import { JobWorkLot, JobWorkLotDocument } from '../jw-lot/jw-lot.schema';
import { Firm } from '../../firms/firm.schema';
import { Party } from '../../parties/party.schema';
import { VoucherSeriesService } from '../../voucher-series/voucher-series.service';
import { JwLotService } from '../jw-lot/jw-lot.service';
import { KarigarLinkageService } from '../karigar-linkage/karigar-linkage.service';
import { JwInvoiceService } from '../jw-invoice/jw-invoice.service';
import { CreateJwOutwardDto } from './dto/create-jw-outward.dto';
import { UpdateJwOutwardDto } from './dto/update-jw-outward.dto';
import { ListJwOutwardDto } from './dto/list-jw-outward.dto';
import { FyLockService } from '../../fiscal-year/fy-lock.service';

@Injectable()
export class JwOutwardChallanService {
  constructor(
    @InjectConnection() private readonly conn: Connection,
    @InjectModel(JobWorkOutwardChallan.name)
    private readonly jwoModel: Model<JobWorkOutwardChallanDocument>,
    @InjectModel(JobWorkInwardChallan.name)
    private readonly jwiModel: Model<JobWorkInwardChallanDocument>,
    @InjectModel(JobWorkLot.name)
    private readonly lotModel: Model<JobWorkLotDocument>,
    @InjectModel(Firm.name)
    private readonly firmModel: Model<Firm>,
    @InjectModel(Party.name)
    private readonly partyModel: Model<Party>,
    private readonly voucherSeriesService: VoucherSeriesService,
    private readonly jwLotService: JwLotService,
    private readonly karigarLinkageService: KarigarLinkageService,
    private readonly jwInvoiceService: JwInvoiceService,
    private readonly fyLock: FyLockService,
  ) {}

  async create(
    wsId: string,
    firmId: string,
    userId: string,
    dto: CreateJwOutwardDto,
  ): Promise<JobWorkOutwardChallanDocument> {
    // F-15 Plan 03: FY-lock guard
    await this.fyLock.assertOpen(wsId, firmId, new Date(dto.voucherDate as any));

    const doc = new this.jwoModel({
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      voucherType: 'job_work_out',
      voucherNumber: '',
      voucherDate: dto.voucherDate,
      status: 'draft',
      partyId: new Types.ObjectId(dto.partyId),
      vehicleNo: dto.vehicleNo,
      transporterName: dto.transporterName,
      transporterGSTIN: dto.transporterGSTIN,
      lrNo: dto.lrNo,
      returnLines: dto.returnLines.map((l, i) => ({
        lineNo: i + 1,
        jobWorkLotId: new Types.ObjectId(l.jobWorkLotId),
        lotNo: l.lotNo,
        itemDescription: l.itemDescription,
        qtyReturning: l.qtyReturning,
        unit: l.unit,
        karigarIds: (l.karigarIds ?? []).map((id) => new Types.ObjectId(id)),
        machineIds: (l.machineIds ?? []).map((id) => new Types.ObjectId(id)),
      })),
      wastageLines: (dto.wastageLines ?? []).map((l, i) => ({
        lineNo: i + 1,
        jobWorkLotId: new Types.ObjectId(l.jobWorkLotId),
        itemDescription: l.itemDescription,
        qtyWasted: l.qtyWasted,
        unit: l.unit,
        reasonCode: l.reasonCode,
        narration: l.narration,
      })),
      karigarIds: dto.karigarIds.map((id) => new Types.ObjectId(id)),
      machineIds: (dto.machineIds ?? []).map((id) => new Types.ObjectId(id)),
      shiftId: dto.shiftId ? new Types.ObjectId(dto.shiftId) : undefined,
      narration: dto.narration,
      // F-11 W4: persist manual place-of-supply override so draft → post round-trip preserves it
      placeOfSupplyStateCode: dto.placeOfSupplyStateCode,
      isDeleted: false,
      createdBy: new Types.ObjectId(userId),
    });
    return doc.save();
  }

  async list(wsId: string, firmId: string, q: ListJwOutwardDto) {
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
      this.jwoModel
        .find(filter)
        .sort({ voucherDate: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .populate('partyId', 'name gstin')
        .exec(),
      this.jwoModel.countDocuments(filter),
    ]);
    return { items, total, page, pageSize };
  }

  async get(
    wsId: string,
    firmId: string,
    id: string,
  ): Promise<JobWorkOutwardChallanDocument> {
    const doc = await this.jwoModel
      .findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .populate('partyId', 'name gstin state')
      .exec();
    if (!doc) throw new NotFoundException('JWO challan not found');
    return doc;
  }

  async update(
    wsId: string,
    firmId: string,
    id: string,
    dto: UpdateJwOutwardDto,
  ): Promise<JobWorkOutwardChallanDocument> {
    const doc = await this.get(wsId, firmId, id);
    if (doc.status !== 'draft')
      throw new BadRequestException('Only draft JWO can be edited');

    // F-15 Plan 03: FY-lock guard against BOTH old and new voucherDate
    await this.fyLock.assertOpen(wsId, firmId, doc.voucherDate);
    if (dto.voucherDate) {
      await this.fyLock.assertOpen(wsId, firmId, new Date(dto.voucherDate as any));
    }

    if (dto.returnLines !== undefined) {
      (doc as any).returnLines = dto.returnLines.map((l, i) => ({
        lineNo: i + 1,
        jobWorkLotId: new Types.ObjectId(l.jobWorkLotId),
        lotNo: l.lotNo,
        itemDescription: l.itemDescription,
        qtyReturning: l.qtyReturning,
        unit: l.unit,
        karigarIds: (l.karigarIds ?? []).map((id) => new Types.ObjectId(id)),
        machineIds: (l.machineIds ?? []).map((id) => new Types.ObjectId(id)),
      }));
    }
    if (dto.wastageLines !== undefined) {
      (doc as any).wastageLines = dto.wastageLines.map((l, i) => ({
        lineNo: i + 1,
        jobWorkLotId: new Types.ObjectId(l.jobWorkLotId),
        itemDescription: l.itemDescription,
        qtyWasted: l.qtyWasted,
        unit: l.unit,
        reasonCode: l.reasonCode,
        narration: l.narration,
      }));
    }
    if (dto.partyId !== undefined)
      (doc as any).partyId = new Types.ObjectId(dto.partyId);
    if (dto.voucherDate !== undefined) doc.voucherDate = dto.voucherDate;
    if (dto.vehicleNo !== undefined) doc.vehicleNo = dto.vehicleNo;
    if (dto.transporterName !== undefined)
      doc.transporterName = dto.transporterName;
    if (dto.transporterGSTIN !== undefined)
      doc.transporterGSTIN = dto.transporterGSTIN;
    if (dto.lrNo !== undefined) doc.lrNo = dto.lrNo;
    if (dto.narration !== undefined) doc.narration = dto.narration;
    if (dto.placeOfSupplyStateCode !== undefined)
      (doc as any).placeOfSupplyStateCode = dto.placeOfSupplyStateCode;
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
   * D-03 + D-19: atomic post — all 4 side effects inside one Mongoose session.
   *
   * Steps:
   *   1. Validate karigarIds non-empty (D-17 mandatory karigar guard)
   *   2. Group return + wastage by lotId; validate sum <= lot.qtyRemaining for each lot (T-F11-W4-01)
   *   3. Validate lots belong to same firm (T-F11-W4-02)
   *   4. Decrement each lot atomically via JwLotService.decrementQty (optimistic lock)
   *   5. Generate voucher number
   *   6. Create KarigarLinkage records (one per karigar — D-05, RESEARCH Pitfall 4)
   *   7. Resolve place-of-supply: jwo.placeOfSupplyStateCode → party.gstin[0:2] → firm.gstin[0:2]
   *   8. Auto-create JW Invoice draft (D-19, RESEARCH Pattern 5)
   *   9. Fill jwo.jwInvoiceId, set status='posted'; save
   *  10. Check each affected parent JWI — if all sibling lots closed/deemed_supply → status='closed'
   *
   * If any step fails → abortTransaction → no partial side effects.
   */
  async post(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
  ): Promise<{
    jwo: JobWorkOutwardChallanDocument;
    invoiceId: Types.ObjectId;
    invoiceNumberHint: string;
  }> {
    // F-15 Plan 03: FY-lock guard — pre-check before opening transaction
    {
      const pre = await this.jwoModel
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
      // ── Load draft JWO ──
      const jwo = await this.jwoModel
        .findOne({
          _id: new Types.ObjectId(id),
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          status: 'draft',
          isDeleted: false,
        })
        .session(session)
        .populate('partyId', 'gstin name state');
      if (!jwo) throw new NotFoundException('JWO not in draft (or not found)');

      // ── Step 1: D-17 mandatory karigar guard ──
      if (!jwo.karigarIds || jwo.karigarIds.length === 0) {
        throw new BadRequestException(
          'At least one karigar must be assigned before posting',
        );
      }

      // ── Step 2 + 3: Group qtys by lotId; validate ──
      const perLot = new Map<
        string,
        { good: number; waste: number }
      >();
      for (const r of jwo.returnLines) {
        const key = String(r.jobWorkLotId);
        const cur = perLot.get(key) ?? { good: 0, waste: 0 };
        cur.good += r.qtyReturning;
        perLot.set(key, cur);
      }
      for (const w of jwo.wastageLines ?? []) {
        const key = String(w.jobWorkLotId);
        const cur = perLot.get(key) ?? { good: 0, waste: 0 };
        cur.waste += w.qtyWasted;
        perLot.set(key, cur);
      }

      for (const [lotId, totals] of perLot.entries()) {
        const lot = await this.lotModel
          .findById(new Types.ObjectId(lotId))
          .session(session);
        if (!lot) throw new BadRequestException(`Lot ${lotId} not found`);
        // T-F11-W4-02: cross-firm lot rejection
        if (String(lot.firmId) !== String(jwo.firmId)) {
          throw new BadRequestException(
            `Lot ${lot.lotNo} belongs to a different firm`,
          );
        }
        // T-F11-W4-01: qty overflow guard (clear per-lot error before optimistic decrement)
        if (totals.good + totals.waste > lot.qtyRemaining) {
          throw new BadRequestException(
            `Lot ${lot.lotNo}: return + wastage (${totals.good + totals.waste}) exceeds remaining qty (${lot.qtyRemaining})`,
          );
        }
      }

      // ── Step 4: Decrement each lot (optimistic lock inside decrementQty) ──
      const affectedLots: {
        lotId: Types.ObjectId;
        inwardChallanId: Types.ObjectId;
      }[] = [];
      for (const [lotId, totals] of perLot.entries()) {
        const updated = await this.jwLotService.decrementQty({
          lotId: new Types.ObjectId(lotId),
          qtyGood: totals.good,
          qtyWastage: totals.waste,
          session,
        });
        affectedLots.push({
          lotId: updated._id as Types.ObjectId,
          inwardChallanId: updated.inwardChallanId as Types.ObjectId,
        });
      }

      // ── Step 5: Generate voucher number ──
      const firm = await this.firmModel
        .findById(jwo.firmId)
        .session(session);
      if (!firm) throw new NotFoundException('Firm not found');
      const fy = this.voucherSeriesService.getFYForDate(
        jwo.voucherDate,
        (firm as any).fyStartMonth ?? 4,
      );
      jwo.voucherNumber = await this.voucherSeriesService.generateNextNumber(
        String(jwo.firmId),
        'job_work_out',
        fy,
      );

      // ── Step 6: KarigarLinkage records (one per karigar — D-05, Pitfall 4) ──
      await this.karigarLinkageService.createBulk({
        workspaceId: jwo.workspaceId as Types.ObjectId,
        firmId: jwo.firmId as Types.ObjectId,
        voucher: {
          _id: jwo._id as Types.ObjectId,
          voucherType: 'job_work_out',
          voucherDate: jwo.voucherDate,
        },
        karigarIds: jwo.karigarIds as Types.ObjectId[],
        machineIds: (jwo.machineIds as Types.ObjectId[] | undefined) ?? undefined,
        shiftId: (jwo.shiftId as Types.ObjectId | undefined) ?? undefined,
        session,
      });

      // ── Step 7: Resolve place-of-supply ──
      // Priority: jwo.placeOfSupplyStateCode → party.gstin[0:2] → firm.gstin[0:2]
      const firmStateCode = (firm as any).gstin
        ? String((firm as any).gstin).substring(0, 2)
        : '';
      const populatedParty = (jwo.partyId as any);
      let partyStateCode = populatedParty?.gstin
        ? String(populatedParty.gstin).substring(0, 2)
        : '';
      if (!partyStateCode && jwo.partyId) {
        // fallback: fresh fetch if populate didn't load gstin
        const partyDoc = await this.partyModel
          .findById((populatedParty?._id) ?? jwo.partyId)
          .session(session)
          .lean();
        partyStateCode = (partyDoc as any)?.gstin
          ? String((partyDoc as any).gstin).substring(0, 2)
          : '';
      }
      const placeOfSupply =
        (jwo as any).placeOfSupplyStateCode || partyStateCode || firmStateCode;

      // ── Step 8: Auto-create JW Invoice draft (D-19, RESEARCH Pattern 5) ──
      const invoice = await this.jwInvoiceService.createDraft({
        workspaceId: jwo.workspaceId as Types.ObjectId,
        firmId: jwo.firmId as Types.ObjectId,
        partyId: (populatedParty?._id ?? jwo.partyId) as Types.ObjectId,
        jwOutwardChallanId: jwo._id as Types.ObjectId,
        jwOutwardChallanNo: jwo.voucherNumber,
        voucherDate: jwo.voucherDate,
        lines: jwo.returnLines.map((l) => ({
          // D-19: one line per return line; description uses lot number
          description: `Embroidery work — Lot ${l.lotNo}`,
          qty: l.qtyReturning,
          unit: l.unit,
          ratePaise: 0, // user must fill before posting invoice
          jobWorkLotId: l.jobWorkLotId as Types.ObjectId,
          karigarIds:
            (l.karigarIds as Types.ObjectId[] | undefined) ??
            (jwo.karigarIds as Types.ObjectId[]),
        })),
        karigarIds: jwo.karigarIds as Types.ObjectId[],
        machineIds: (jwo.machineIds as Types.ObjectId[] | undefined) ?? undefined,
        placeOfSupplyStateCode: placeOfSupply,
        userId,
        session,
      });

      // ── Step 9: Stamp invoice reference + set posted ──
      (jwo as any).jwInvoiceId = invoice._id as Types.ObjectId;
      jwo.status = 'posted';
      await jwo.save({ session });

      // ── Step 10: Auto-close parent JWI challans whose lots are all closed/deemed_supply ──
      const parentChallanIds = Array.from(
        new Set(affectedLots.map((a) => String(a.inwardChallanId))),
      );
      for (const parentId of parentChallanIds) {
        const siblingLots = await this.lotModel
          .find({
            inwardChallanId: new Types.ObjectId(parentId),
            isDeleted: false,
          })
          .session(session)
          .select('status')
          .lean();
        const allDone =
          siblingLots.length > 0 &&
          siblingLots.every(
            (l) => l.status === 'closed' || l.status === 'deemed_supply',
          );
        if (allDone) {
          await this.jwiModel.updateOne(
            { _id: new Types.ObjectId(parentId), status: 'posted' },
            { $set: { status: 'closed' } },
            { session },
          );
        }
      }

      await session.commitTransaction();
      return {
        jwo,
        invoiceId: invoice._id as Types.ObjectId,
        invoiceNumberHint: 'JWS-DRAFT',
      };
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
  ): Promise<JobWorkOutwardChallanDocument> {
    const doc = await this.get(wsId, firmId, id);
    if (doc.status !== 'draft')
      throw new BadRequestException('Only draft JWO can be cancelled');
    // F-15 Plan 03: FY-lock guard
    await this.fyLock.assertOpen(wsId, firmId, doc.voucherDate);
    doc.isDeleted = true;
    return doc.save();
  }
}
