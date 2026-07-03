import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { LedgerEntry } from '../../sales/ledger-posting/ledger-entry.schema';
import { StockSummaryService } from '../../inventory/stock-summary/stock-summary.service';
import { withFinanceSpan } from '../../common/finance-observability';

@Injectable()
export class InventoryReportsService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // Read-only inventory reports: spans wrap each report method; no PostHog (no writes).
  private readonly tracer = trace.getTracer('finance');

  constructor(
    @InjectModel(LedgerEntry.name) private readonly ledgerModel: Model<LedgerEntry>,
    private readonly stockSummaryService: StockSummaryService,
  ) {}

  // ─── Stock Summary (R-33) — delegates to StockSummaryService ─────────────

  async getStockSummary(wsId: string, firmId: string) {
    return withFinanceSpan(
      this.tracer,
      'finance.getStockSummary',
      { workspaceId: wsId, firmId },
      async () => {
        return this.stockSummaryService.list(wsId, firmId, {});
      },
    );
  }

  // ─── Item Ledger (R-34) ───────────────────────────────────────────────────

  async getItemLedger(
    wsId: string,
    firmId: string,
    itemId: string,
    dateFrom: Date,
    dateTo: Date,
    page = 1,
    limit = 100,
  ) {
    return withFinanceSpan(
      this.tracer,
      'finance.getItemLedger',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);
        const itemOid = new Types.ObjectId(itemId);

        try {
          const StockMovementModel = (this.ledgerModel as any).db.model('StockMovement');
          const [total, movements] = await Promise.all([
            StockMovementModel.countDocuments({
              workspaceId: wsOid,
              firmId: firmOid,
              itemId: itemOid,
              movementDate: { $gte: dateFrom, $lte: dateTo },
            }),
            StockMovementModel.find({
              workspaceId: wsOid,
              firmId: firmOid,
              itemId: itemOid,
              movementDate: { $gte: dateFrom, $lte: dateTo },
            })
              .sort({ movementDate: 1 })
              .skip((page - 1) * limit)
              .limit(limit)
              .lean()
              .exec(),
          ]);
          return { rows: movements, total };
        } catch {
          return { rows: [], total: 0, message: 'StockMovement data not available' };
        }
      },
    );
  }

  // ─── Item Profitability (R-35) ────────────────────────────────────────────

  async getItemProfitability(wsId: string, firmId: string, dateFrom: Date, dateTo: Date) {
    return withFinanceSpan(
      this.tracer,
      'finance.getItemProfitability',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

        try {
          const SaleInvoiceModel = (this.ledgerModel as any).db.model('SaleInvoice');
          const revenue = await SaleInvoiceModel.aggregate([
            {
              $match: {
                workspaceId: wsOid,
                firmId: firmOid,
                state: 'posted',
                isDeleted: false,
                voucherDate: { $gte: dateFrom, $lte: dateTo },
              },
            },
            { $unwind: '$lineItems' },
            {
              $group: {
                _id: '$lineItems.itemId',
                itemName: { $first: '$lineItems.itemName' },
                itemCode: { $first: '$lineItems.itemCode' },
                revenuePaise: { $sum: '$lineItems.taxableValuePaise' },
                qtySold: { $sum: '$lineItems.qty' },
              },
            },
            { $sort: { revenuePaise: -1 } },
          ]);

          // COGS: StockMovement cost for outward movements matched to same item in period
          const StockMovementModel = (this.ledgerModel as any).db.model('StockMovement');
          const cogsByItem = await StockMovementModel.aggregate([
            {
              $match: {
                workspaceId: wsOid,
                firmId: firmOid,
                movementType: { $in: ['sale_out', 'outward'] },
                movementDate: { $gte: dateFrom, $lte: dateTo },
              },
            },
            { $group: { _id: '$itemId', cogsPaise: { $sum: '$costPaise' } } },
          ]);

          const cogsMap = new Map(
            (cogsByItem as any[]).map((r) => [r._id?.toString(), r.cogsPaise]),
          );
          const rows = (revenue as any[]).map((r) => {
            const cogsPaise = cogsMap.get(r._id?.toString()) ?? 0;
            const grossProfitPaise = r.revenuePaise - cogsPaise;
            return {
              itemId: r._id?.toString(),
              itemName: r.itemName,
              itemCode: r.itemCode,
              revenuePaise: r.revenuePaise,
              cogsPaise,
              grossProfitPaise,
              grossMarginPct: r.revenuePaise > 0 ? (grossProfitPaise / r.revenuePaise) * 100 : 0,
              qtySold: r.qtySold,
            };
          });
          return { rows };
        } catch {
          return {
            rows: [],
            message: 'Item profitability requires SaleInvoice and StockMovement data',
          };
        }
      },
    );
  }

  // ─── Godown Stock (R-36) ──────────────────────────────────────────────────

  async getGodownStock(wsId: string, firmId: string, godownId?: string) {
    return withFinanceSpan(
      this.tracer,
      'finance.getGodownStock',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

        try {
          const GodownBalanceModel = (this.ledgerModel as any).db.model('GodownBalance');
          const filter: any = { workspaceId: wsOid, firmId: firmOid };
          if (godownId) filter.godownId = new Types.ObjectId(godownId);
          const balances = await GodownBalanceModel.find(filter)
            .sort({ godownId: 1, itemId: 1 })
            .lean()
            .exec();
          return { rows: balances };
        } catch {
          return { rows: [], message: 'GodownBalance data not available' };
        }
      },
    );
  }

  // ─── Wastage Register (R-39) ─────────────────────────────────────────────

  async getWastageRegister(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
    page = 1,
    limit = 100,
  ) {
    return withFinanceSpan(
      this.tracer,
      'finance.getWastageRegister',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

        try {
          const WastageEntryModel = (this.ledgerModel as any).db.model('WastageEntry');
          const [total, entries] = await Promise.all([
            WastageEntryModel.countDocuments({
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $gte: dateFrom, $lte: dateTo },
            }),
            WastageEntryModel.find({
              workspaceId: wsOid,
              firmId: firmOid,
              entryDate: { $gte: dateFrom, $lte: dateTo },
            })
              .sort({ entryDate: -1 })
              .skip((page - 1) * limit)
              .limit(limit)
              .lean()
              .exec(),
          ]);
          return { rows: entries, total };
        } catch {
          return { rows: [], total: 0, message: 'WastageEntry data not available' };
        }
      },
    );
  }

  // ─── Stock Transfer Register (R-40) ──────────────────────────────────────

  async getStockTransferRegister(
    wsId: string,
    firmId: string,
    dateFrom: Date,
    dateTo: Date,
    page = 1,
    limit = 100,
  ) {
    return withFinanceSpan(
      this.tracer,
      'finance.getStockTransferRegister',
      { workspaceId: wsId, firmId },
      async () => {
        const wsOid = new Types.ObjectId(wsId);
        const firmOid = new Types.ObjectId(firmId);

        try {
          const StockTransferModel = (this.ledgerModel as any).db.model('StockTransfer');
          const [total, transfers] = await Promise.all([
            StockTransferModel.countDocuments({
              workspaceId: wsOid,
              firmId: firmOid,
              transferDate: { $gte: dateFrom, $lte: dateTo },
            }),
            StockTransferModel.find({
              workspaceId: wsOid,
              firmId: firmOid,
              transferDate: { $gte: dateFrom, $lte: dateTo },
            })
              .sort({ transferDate: -1 })
              .skip((page - 1) * limit)
              .limit(limit)
              .lean()
              .exec(),
          ]);
          return { rows: transfers, total };
        } catch {
          return { rows: [], total: 0, message: 'StockTransfer data not available' };
        }
      },
    );
  }
}
