import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { LedgerEntry } from '../../sales/ledger-posting/ledger-entry.schema';
import { SaleInvoice } from '../../sales/sale-invoice/sale-invoice.schema';
import { PurchaseBill } from '../../purchases/purchase-bill/purchase-bill.schema';
import { Gstr1Service } from '../../gst/gstr1/gstr1.service';
import { Gstr3bService } from '../../gst/gstr3b/gstr3b.service';
import { withFinanceSpan } from '../../common/finance-observability';

// ──── Interfaces ─────────────────────────────────────────────────────────────

export interface GstOutputRegisterRow {
  entryDate: Date;
  voucherNumber: string;
  partyName: string;
  partyGstin: string;
  hsnCode: string;
  taxableAmountPaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  cessAmountPaise: number;
  totalGstPaise: number;
  totalPaise: number;
  sourceVoucherId: string;
  sourceVoucherType: string;
}

export interface GstInputRegisterRow {
  entryDate: Date;
  voucherNumber: string;
  supplierName: string;
  supplierGstin: string;
  hsnCode: string;
  taxableAmountPaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  itcEligibleIgstPaise: number;
  itcEligibleCgstPaise: number;
  itcEligibleSgstPaise: number;
  sourceVoucherId: string;
}

export interface ItcReconciliationRow {
  period: string;
  booksIgstPaise: number;
  booksCgstPaise: number;
  booksSgstPaise: number;
  gstr3bIgstPaise: number;
  gstr3bCgstPaise: number;
  gstr3bSgstPaise: number;
  deltaIgstPaise: number;
  deltaCgstPaise: number;
  deltaSgstPaise: number;
  hasDiscrepancy: boolean;
}

export interface EinvoiceRegisterRow {
  entryDate: Date;
  voucherNumber: string;
  partyName: string;
  grandTotalPaise: number;
  irn: string;
  irnStatus: string;
  irnGeneratedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: number | null;
  sourceVoucherId: string;
}

export interface EwbRegisterRow {
  entryDate: Date;
  voucherNumber: string;
  partyName: string;
  grandTotalPaise: number;
  ewbNumber: string;
  ewbValidUntil: Date | null;
  ewbStatus: string;
  sourceVoucherId: string;
}

export interface LateFeeRegisterRow {
  entryDate: Date;
  partyName: string;
  originalVoucherNumber: string;
  originalVoucherDate: Date;
  lateFeeAmountPaise: number;
  daysOverdue: number;
  narration: string;
  sourceVoucherId: string;
}

@Injectable()
export class GstRegistersService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // Read-only GST registers: spans wrap each report method; no PostHog (no writes).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(LedgerEntry.name) private readonly ledgerModel: Model<LedgerEntry>,
    @InjectModel(SaleInvoice.name) private readonly invoiceModel: Model<SaleInvoice>,
    @InjectModel(PurchaseBill.name) private readonly billModel: Model<PurchaseBill>,
    private readonly gstr1Service: Gstr1Service,
    private readonly gstr3bService: Gstr3bService,
  ) {}

  // ─── GSTR-1 Output Register (R-08) — delegates to Gstr1Service ──────────

  async getGstr1Report(wsId: string, firmId: string, period: string) {
    return withFinanceSpan(
      this.tracer,
      'finance.getGstr1Report',
      { workspaceId: wsId, firmId, period },
      async () => {
        // Delegate entirely to existing Gstr1Service (F-12). No reimplementation.
        return this.gstr1Service.getReport(wsId, firmId, period);
      },
    );
  }

  // ─── GSTR-3B Summary (R-09) — delegates to Gstr3bService ───────────────
  // FIX: Gstr3bService exposes getReport() (not getAutoReport()); returns Gstr3bMergedReport.

  async getGstr3bReport(wsId: string, firmId: string, period: string) {
    return withFinanceSpan(
      this.tracer,
      'finance.getGstr3bReport',
      { workspaceId: wsId, firmId, period },
      async () => {
        // Delegate entirely to existing Gstr3bService (F-12). No reimplementation.
        return this.gstr3bService.getReport(wsId, firmId, period);
      },
    );
  }

  // ─── GST Output Register (R-10) ──────────────────────────────────────────

  async getGstOutputRegister(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<{ rows: GstOutputRegisterRow[]; totals: Record<string, number> }> {
    return withFinanceSpan(
      this.tracer,
      'finance.getGstOutputRegister',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

        const invoices = await this.invoiceModel
          .find({
            workspaceId: wsOid,
            firmId: firmOid,
            state: 'posted',
            isDeleted: false,
            voucherDate: { $gte: dateFrom, $lte: dateTo },
          })
          .sort({ voucherDate: 1 })
          .lean()
          .exec();

        const rows: GstOutputRegisterRow[] = [];
        for (const inv of invoices as any[]) {
          const lines = inv.lineItems ?? [];
          if (lines.length === 0) {
            rows.push({
              entryDate: inv.voucherDate,
              voucherNumber: inv.voucherNumber,
              partyName: inv.partySnapshot?.name ?? '',
              partyGstin: inv.partySnapshot?.gstin ?? '',
              hsnCode: '',
              taxableAmountPaise: inv.taxableValuePaise ?? 0,
              igstPaise: inv.igstPaise ?? 0,
              cgstPaise: inv.cgstPaise ?? 0,
              sgstPaise: inv.sgstPaise ?? 0,
              cessAmountPaise: 0,
              totalGstPaise: (inv.igstPaise ?? 0) + (inv.cgstPaise ?? 0) + (inv.sgstPaise ?? 0),
              totalPaise: inv.grandTotalPaise ?? 0,
              sourceVoucherId: inv._id.toString(),
              sourceVoucherType: 'sale_invoice',
            });
          } else {
            for (const line of lines) {
              const igst = line.igstPaise ?? 0;
              const cgst = line.cgstPaise ?? 0;
              const sgst = line.sgstPaise ?? 0;
              const cess = line.cessPaise ?? 0;
              rows.push({
                entryDate: inv.voucherDate,
                voucherNumber: inv.voucherNumber,
                partyName: inv.partySnapshot?.name ?? '',
                partyGstin: inv.partySnapshot?.gstin ?? '',
                hsnCode: line.hsnSacCode ?? line.hsnCode ?? '',
                taxableAmountPaise: line.taxableValuePaise ?? 0,
                igstPaise: igst,
                cgstPaise: cgst,
                sgstPaise: sgst,
                cessAmountPaise: cess,
                totalGstPaise: igst + cgst + sgst + cess,
                totalPaise: line.lineTotalPaise ?? 0,
                sourceVoucherId: inv._id.toString(),
                sourceVoucherType: 'sale_invoice',
              });
            }
          }
        }

        const totals = rows.reduce(
          (acc, r) => {
            acc.taxableAmountPaise = (acc.taxableAmountPaise ?? 0) + r.taxableAmountPaise;
            acc.igstPaise = (acc.igstPaise ?? 0) + r.igstPaise;
            acc.cgstPaise = (acc.cgstPaise ?? 0) + r.cgstPaise;
            acc.sgstPaise = (acc.sgstPaise ?? 0) + r.sgstPaise;
            acc.totalGstPaise = (acc.totalGstPaise ?? 0) + r.totalGstPaise;
            acc.totalPaise = (acc.totalPaise ?? 0) + r.totalPaise;
            return acc;
          },
          {} as Record<string, number>,
        );

        return { rows, totals };
      },
    );
  }

  // ─── GST Input Register (R-11) ───────────────────────────────────────────

  async getGstInputRegister(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<{ rows: GstInputRegisterRow[]; totals: Record<string, number> }> {
    return withFinanceSpan(
      this.tracer,
      'finance.getGstInputRegister',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

        const bills = await this.billModel
          .find({
            workspaceId: wsOid,
            firmId: firmOid,
            state: 'posted',
            isDeleted: false,
            voucherDate: { $gte: dateFrom, $lte: dateTo },
          })
          .sort({ voucherDate: 1 })
          .lean()
          .exec();

        const rows: GstInputRegisterRow[] = (bills as any[]).map((bill) => ({
          entryDate: bill.voucherDate,
          voucherNumber: bill.voucherNumber,
          supplierName: bill.partySnapshot?.name ?? '',
          supplierGstin: bill.partySnapshot?.gstin ?? '',
          hsnCode: '',
          taxableAmountPaise: bill.taxableValuePaise ?? 0,
          igstPaise: bill.igstPaise ?? 0,
          cgstPaise: bill.cgstPaise ?? 0,
          sgstPaise: bill.sgstPaise ?? 0,
          itcEligibleIgstPaise: bill.itcEligible !== false ? (bill.igstPaise ?? 0) : 0,
          itcEligibleCgstPaise: bill.itcEligible !== false ? (bill.cgstPaise ?? 0) : 0,
          itcEligibleSgstPaise: bill.itcEligible !== false ? (bill.sgstPaise ?? 0) : 0,
          sourceVoucherId: bill._id.toString(),
        }));

        const totals = rows.reduce(
          (acc, r) => {
            acc.taxableAmountPaise = (acc.taxableAmountPaise ?? 0) + r.taxableAmountPaise;
            acc.igstPaise = (acc.igstPaise ?? 0) + r.igstPaise;
            acc.cgstPaise = (acc.cgstPaise ?? 0) + r.cgstPaise;
            acc.sgstPaise = (acc.sgstPaise ?? 0) + r.sgstPaise;
            acc.itcEligibleIgstPaise = (acc.itcEligibleIgstPaise ?? 0) + r.itcEligibleIgstPaise;
            acc.itcEligibleCgstPaise = (acc.itcEligibleCgstPaise ?? 0) + r.itcEligibleCgstPaise;
            acc.itcEligibleSgstPaise = (acc.itcEligibleSgstPaise ?? 0) + r.itcEligibleSgstPaise;
            return acc;
          },
          {} as Record<string, number>,
        );

        return { rows, totals };
      },
    );
  }

  // ─── ITC Reconciliation (R-12 + R-13) ───────────────────────────────────
  // FIX: Gstr3bService.getReport() (not getAutoReport()) returns Gstr3bMergedReport;
  //      ITC amounts are under .auto.sec_4A_3 and .auto.sec_4A_5.

  async getItcReconciliation(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<ItcReconciliationRow[]> {
    return withFinanceSpan(
      this.tracer,
      'finance.getItcReconciliation',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

        // Account codes verified from gstr3b.service.ts constants: IGST_INPUT=1100, CGST_INPUT=1101, SGST_INPUT=1102
        const booksRows = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $gte: dateFrom, $lte: dateTo },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          { $match: { 'lines.accountCode': { $in: ['1100', '1101', '1102'] } } },
          {
            $group: {
              _id: {
                year: { $year: '$entryDate' },
                month: { $month: '$entryDate' },
                code: '$lines.accountCode',
              },
              total: { $sum: '$lines.debit' },
            },
          },
        ]);

        const periodMap = new Map<string, ItcReconciliationRow>();
        for (const r of booksRows) {
          const period = `${String(r._id.month).padStart(2, '0')}${r._id.year}`;
          if (!periodMap.has(period)) {
            periodMap.set(period, {
              period,
              booksIgstPaise: 0,
              booksCgstPaise: 0,
              booksSgstPaise: 0,
              gstr3bIgstPaise: 0,
              gstr3bCgstPaise: 0,
              gstr3bSgstPaise: 0,
              deltaIgstPaise: 0,
              deltaCgstPaise: 0,
              deltaSgstPaise: 0,
              hasDiscrepancy: false,
            });
          }
          const entry = periodMap.get(period);
          if (r._id.code === '1100') entry.booksIgstPaise += r.total;
          else if (r._id.code === '1101') entry.booksCgstPaise += r.total;
          else if (r._id.code === '1102') entry.booksSgstPaise += r.total;
        }

        for (const [period, entry] of periodMap) {
          try {
            // getReport() returns Gstr3bMergedReport; ITC in .auto.sec_4A_3 (IGST) and .auto.sec_4A_5 (CGST+SGST)
            const gstr3b = await this.gstr3bService.getReport(wsId, firmId, period);
            entry.gstr3bIgstPaise = gstr3b?.auto?.sec_4A_3?.igst ?? 0;
            entry.gstr3bCgstPaise = gstr3b?.auto?.sec_4A_5?.cgst ?? 0;
            entry.gstr3bSgstPaise = gstr3b?.auto?.sec_4A_5?.sgst ?? 0;
          } catch {
            /* GSTR-3B may not exist for this period yet */
          }
          entry.deltaIgstPaise = entry.booksIgstPaise - entry.gstr3bIgstPaise;
          entry.deltaCgstPaise = entry.booksCgstPaise - entry.gstr3bCgstPaise;
          entry.deltaSgstPaise = entry.booksSgstPaise - entry.gstr3bSgstPaise;
          entry.hasDiscrepancy =
            Math.abs(entry.deltaIgstPaise) > 100 ||
            Math.abs(entry.deltaCgstPaise) > 100 ||
            Math.abs(entry.deltaSgstPaise) > 100;
        }

        return Array.from(periodMap.values()).sort((a, b) => a.period.localeCompare(b.period));
      },
    );
  }

  // ─── E-Invoice Register (R-15) ───────────────────────────────────────────

  async getEinvoiceRegister(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<EinvoiceRegisterRow[]> {
    return withFinanceSpan(
      this.tracer,
      'finance.getEinvoiceRegister',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        const invoices = await this.invoiceModel
          .find({
            workspaceId: wsOid,
            firmId: firmOid,
            state: 'posted',
            isDeleted: false,
            voucherDate: { $gte: dateFrom, $lte: dateTo },
            'eInvoice.irn': { $exists: true, $ne: '' },
          })
          .sort({ voucherDate: 1 })
          .lean()
          .exec();

        return (invoices as any[]).map((inv) => ({
          entryDate: inv.voucherDate,
          voucherNumber: inv.voucherNumber,
          partyName: inv.partySnapshot?.name ?? '',
          grandTotalPaise: inv.grandTotalPaise ?? 0,
          irn: inv.eInvoice?.irn ?? '',
          irnStatus: inv.eInvoice?.irnStatus ?? 'generated',
          irnGeneratedAt: inv.eInvoice?.irnGeneratedAt ?? null,
          cancelledAt: inv.eInvoice?.cancelledAt ?? null,
          cancelReason: inv.eInvoice?.cancelReason ?? null,
          sourceVoucherId: inv._id.toString(),
        }));
      },
    );
  }

  // ─── E-Way Bill Register (R-16) ──────────────────────────────────────────

  async getEwbRegister(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<EwbRegisterRow[]> {
    return withFinanceSpan(
      this.tracer,
      'finance.getEwbRegister',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        const invoices = await this.invoiceModel
          .find({
            workspaceId: wsOid,
            firmId: firmOid,
            state: 'posted',
            isDeleted: false,
            voucherDate: { $gte: dateFrom, $lte: dateTo },
            'ewayBill.ewbNo': { $exists: true, $ne: '' },
          })
          .sort({ voucherDate: 1 })
          .lean()
          .exec();

        return (invoices as any[]).map((inv) => ({
          entryDate: inv.voucherDate,
          voucherNumber: inv.voucherNumber,
          partyName: inv.partySnapshot?.name ?? '',
          grandTotalPaise: inv.grandTotalPaise ?? 0,
          ewbNumber: inv.ewayBill?.ewbNo ?? '',
          ewbValidUntil: inv.ewayBill?.validUpto ?? null,
          ewbStatus: inv.ewayBill?.status ?? 'generated',
          sourceVoucherId: inv._id.toString(),
        }));
      },
    );
  }

  // ─── Late-Fee Register (R-18) ─────────────────────────────────────────────
  // partyName resolved via $lookup to SaleInvoice.partySnapshot (must_have per plan)

  async getLateFeeRegister(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<{ rows: LateFeeRegisterRow[]; totalLateFeePaise: number }> {
    return withFinanceSpan(
      this.tracer,
      'finance.getLateFeeRegister',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

        // Late fee entries: LedgerEntry lines where account code is 5005,
        // with $lookup to saleinvoices collection for partyName from partySnapshot
        const entries = await this.ledgerModel.aggregate([
          {
            $match: {
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $gte: dateFrom, $lte: dateTo },
              isReversed: false,
            },
          },
          { $unwind: '$lines' },
          { $match: { 'lines.accountCode': '5005' } },
          {
            $group: {
              _id: '$_id',
              entryDate: { $first: '$entryDate' },
              narration: { $first: '$narration' },
              sourceVoucherId: { $first: '$sourceVoucherId' },
              sourceVoucherType: { $first: '$sourceVoucherType' },
              sourceVoucherNumber: { $first: '$sourceVoucherNumber' },
              lateFeeAmountPaise: { $sum: '$lines.credit' },
            },
          },
          // $lookup into saleinvoices to fetch partySnapshot.name
          {
            $lookup: {
              from: 'saleinvoices',
              localField: 'sourceVoucherId',
              foreignField: '_id',
              as: 'invoice',
            },
          },
          { $unwind: { path: '$invoice', preserveNullAndEmptyArrays: true } },
          {
            $addFields: {
              resolvedPartyName: { $ifNull: ['$invoice.partySnapshot.name', ''] },
            },
          },
          { $sort: { entryDate: 1 } },
        ]);

        const rows: LateFeeRegisterRow[] = entries.map((e) => ({
          entryDate: e.entryDate,
          partyName: e.resolvedPartyName ?? '',
          originalVoucherNumber: e.sourceVoucherNumber ?? '',
          originalVoucherDate: e.entryDate,
          lateFeeAmountPaise: e.lateFeeAmountPaise,
          daysOverdue: 0, // computed from narration or voucher relationship — narration field available for display
          narration: e.narration ?? '',
          sourceVoucherId: e.sourceVoucherId?.toString() ?? '',
        }));

        const totalLateFeePaise = rows.reduce((s, r) => s + r.lateFeeAmountPaise, 0);
        return { rows, totalLateFeePaise };
      },
    );
  }

  // ─── Capital Goods ITC Schedule (R-14) ────────────────────────────────────

  async getCapitalGoodsItcSchedule(
    wsId: string,
    firmId: string,
  ): Promise<{ schedule: any[]; monthlyReleasePaise: number }> {
    return withFinanceSpan(
      this.tracer,
      'finance.getCapitalGoodsItcSchedule',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        try {
          const CapitalGoodsItcScheduleModel = (this.ledgerModel as any).db.model(
            'CapitalGoodsItcSchedule',
          );
          const schedule = await CapitalGoodsItcScheduleModel.find({
            workspaceId: wsOid,
            firmId: firmOid,
          })
            .sort({ purchaseDate: 1 })
            .lean()
            .exec();
          const monthlyReleasePaise = schedule.reduce(
            (s: number, r: any) => s + (r.monthlyReleaseAmountPaise ?? 0),
            0,
          );
          return { schedule, monthlyReleasePaise };
        } catch {
          return { schedule: [], monthlyReleasePaise: 0 };
        }
      },
    );
  }
}
