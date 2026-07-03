import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { LedgerEntry } from '../../sales/ledger-posting/ledger-entry.schema';
import { withFinanceSpan } from '../../common/finance-observability';

@Injectable()
export class ManufacturingReportsService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // Read-only manufacturing reports: spans wrap each report method; no PostHog (no writes).
  private readonly tracer = trace.getTracer('finance');

  constructor(@InjectModel(LedgerEntry.name) private readonly ledgerModel: Model<LedgerEntry>) {}

  private db() {
    return (this.ledgerModel as any).db;
  }

  // ─── Manufacturing Voucher Register (R-41) ────────────────────────────────
  // ManufacturingVoucher.status: 'draft' | 'in_progress' | 'completed' | 'cancelled'
  // voucherDate is the schedule date; completedAt is the actual completion timestamp

  async getMvRegister(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
    page = 1,
    limit = 100,
  ) {
    return withFinanceSpan(
      this.tracer,
      'finance.getMvRegister',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        try {
          const MvModel = this.db().model('ManufacturingVoucher');
          const [total, rows] = await Promise.all([
            MvModel.countDocuments({
              workspaceId: wsOid,
              firmId: firmOid,
              voucherDate: { $gte: dateFrom, $lte: dateTo },
              isDeleted: false,
            }),
            MvModel.find({
              workspaceId: wsOid,
              firmId: firmOid,
              voucherDate: { $gte: dateFrom, $lte: dateTo },
              isDeleted: false,
            })
              .sort({ voucherDate: -1 })
              .skip((page - 1) * limit)
              .limit(limit)
              .lean()
              .exec(),
          ]);
          return { rows, total };
        } catch {
          return { rows: [], total: 0, message: 'ManufacturingVoucher data not available' };
        }
      },
    );
  }

  // ─── BoM Cost Analysis (R-42) ─────────────────────────────────────────────
  // Uses totalInputCostPaise (actual), standardFgCostPaise (standard), variancePaise

  async getBomCostAnalysis(wsId: string, firmId: string, dateFrom: Date, dateTo: Date) {
    return withFinanceSpan(
      this.tracer,
      'finance.getBomCostAnalysis',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        try {
          const MvModel = this.db().model('ManufacturingVoucher');
          const mvs = await MvModel.find({
            workspaceId: wsOid,
            firmId: firmOid,
            status: 'completed',
            completedAt: { $gte: dateFrom, $lte: dateTo },
            isDeleted: false,
          })
            .lean()
            .exec();

          return {
            rows: (mvs as any[]).map((mv) => ({
              mvId: mv._id.toString(),
              voucherNumber: mv.voucherNumber,
              bomId: mv.bomId?.toString(),
              finishedItemId: mv.finishedItemId?.toString(),
              finishedUnit: mv.finishedUnit ?? '',
              actualFinishedQty: mv.actualFinishedQty ?? 0,
              // totalInputCostPaise = raw material + overhead (actual)
              actualCostPaise: mv.totalInputCostPaise ?? 0,
              // standardFgCostPaise only populated when costMethod = 'standard'
              standardCostPaise: mv.standardFgCostPaise ?? 0,
              // variancePaise = totalInputCost - totalOutputCost (stored on MV)
              variancePaise: mv.variancePaise ?? 0,
              completedAt: mv.completedAt,
            })),
          };
        } catch {
          return { rows: [], message: 'Manufacturing data not available' };
        }
      },
    );
  }

  // ─── Job-Work Pending (R-43) — lots sent but not returned ────────────────
  // Model class: JobWorkLot — collection: jobworklots
  // status: 'pending' | 'partial' | 'closed' | 'deemed_supply'

  async getJobWorkPending(wsId: string, firmId: string) {
    return withFinanceSpan(
      this.tracer,
      'finance.getJobWorkPending',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        try {
          const JwLotModel = this.db().model('JobWorkLot');
          const lots = await JwLotModel.find({
            workspaceId: wsOid,
            firmId: firmOid,
            status: 'pending',
            isDeleted: false,
          })
            .sort({ inwardDate: 1 })
            .lean()
            .exec();
          return { rows: lots };
        } catch {
          return {
            rows: [],
            message: 'Job-Work module not yet active. Complete Phase F-11 first.',
          };
        }
      },
    );
  }

  // ─── Karigar Productivity (R-44) ─────────────────────────────────────────
  // KarigarLinkage fields: karigarId, voucherDate, estimatedCostPaise
  // Collection: karigarlinkages

  async getKarigarProductivity(wsId: string, firmId: string, dateFrom: Date, dateTo: Date) {
    return withFinanceSpan(
      this.tracer,
      'finance.getKarigarProductivity',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        try {
          const KarigarLinkageModel = this.db().model('KarigarLinkage');
          const results = await KarigarLinkageModel.aggregate([
            {
              $match: {
                workspaceId: wsOid,
                firmId: firmOid,
                voucherDate: { $gte: dateFrom, $lte: dateTo },
              },
            },
            {
              $group: {
                _id: '$karigarId',
                totalEstimatedCostPaise: { $sum: '$estimatedCostPaise' },
                totalEstimatedHours: { $sum: '$estimatedHours' },
                jobCount: { $sum: 1 },
              },
            },
            { $sort: { jobCount: -1 } },
          ]);
          return { rows: results };
        } catch {
          return {
            rows: [],
            message: 'Karigar Productivity requires Phase F-11 (Job-Work) to be complete.',
          };
        }
      },
    );
  }

  // ─── Machine Output (R-45) ───────────────────────────────────────────────
  // ManufacturingVoucher has machineIds (array) and actualFinishedQty
  // Group by machineIds using $unwind for per-machine stats

  async getMachineOutput(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
    machineId?: string,
  ) {
    return withFinanceSpan(
      this.tracer,
      'finance.getMachineOutput',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        try {
          const MvModel = this.db().model('ManufacturingVoucher');
          const matchFilter: any = {
            workspaceId: wsOid,
            firmId: firmOid,
            status: 'completed',
            completedAt: { $gte: dateFrom, $lte: dateTo },
            isDeleted: false,
          };
          if (machineId) matchFilter.machineIds = new Types.ObjectId(machineId);

          const results = await MvModel.aggregate([
            { $match: matchFilter },
            { $unwind: { path: '$machineIds', preserveNullAndEmptyArrays: false } },
            {
              $group: {
                _id: '$machineIds',
                totalQtyProduced: { $sum: '$actualFinishedQty' },
                totalMvs: { $sum: 1 },
                totalInputCostPaise: { $sum: '$totalInputCostPaise' },
              },
            },
            { $sort: { totalQtyProduced: -1 } },
          ]);
          return { rows: results };
        } catch {
          return {
            rows: [],
            message: 'Machine Output requires ManufacturingVoucher data with machineIds.',
          };
        }
      },
    );
  }
}
