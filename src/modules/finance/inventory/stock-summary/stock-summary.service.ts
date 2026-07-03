import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  GodownBalance,
  GodownBalanceDocument,
} from '../godown-balances/godown-balance.schema';
import { Item } from '../../items/item.schema';
import { Document } from 'mongoose';
import {
  ItemValuationLayer,
  ItemValuationLayerDocument,
} from '../valuation/item-valuation-layer.schema';
import { Lot, LotDocument } from '../lots/lot.schema';
import { Firm } from '../../firms/firm.schema';
import { StockSummaryQueryDto } from './dto/stock-summary-query.dto';

type ItemDocument = Item & Document;
type FirmDocument = Firm & Document;

export interface StockSummaryRow {
  itemId: string;
  itemCode: string;
  name: string;
  categoryName?: string;
  unitName?: string;
  reorderQty: number;
  onHandQty: number; // sum of GodownBalance.qty across godowns (bucketType='stock')
  reservedQty: number; // Item.reservedQty
  availableQty: number; // onHandQty - reservedQty
  avgCostPaise: number; // FIFO weighted avg of unexhausted layers OR Item.movingAvgCostPaise
  stockValuePaise: number; // onHandQty * avgCostPaise
  lotCount: number; // active (non-deleted, qtyRemaining>0) lots for this item
  belowReorder: boolean;
  expiringSoonCount: number; // lots with expiryDate within 30 days
}

export interface StockSummaryResponse {
  kpi: {
    totalSkus: number;
    totalStockValuePaise: number;
    itemsBelowReorder: number;
    lotsExpiringSoon: number;
  };
  rows: StockSummaryRow[];
}

@Injectable()
export class StockSummaryService {
  constructor(
    @InjectModel(GodownBalance.name)
    private readonly balanceModel: Model<GodownBalanceDocument>,
    @InjectModel(Item.name)
    private readonly itemModel: Model<ItemDocument>,
    @InjectModel(ItemValuationLayer.name)
    private readonly layerModel: Model<ItemValuationLayerDocument>,
    @InjectModel(Lot.name)
    private readonly lotModel: Model<LotDocument>,
    @InjectModel(Firm.name)
    private readonly firmModel: Model<FirmDocument>,
  ) {}

  async list(
    workspaceId: string,
    firmId: string,
    query: StockSummaryQueryDto,
  ): Promise<StockSummaryResponse> {
    const wsObj = new Types.ObjectId(workspaceId);
    const firmObj = new Types.ObjectId(firmId);

    // Read firm's valuation method
    const firm = await this.firmModel.findById(firmObj).lean();
    const valuationMethod: 'fifo' | 'moving_average' =
      (firm as any)?.inventoryValuationMethod ?? 'moving_average';

    // 1) Aggregate GodownBalance per item (bucketType='stock' only)
    // Sample/consignment buckets excluded from on-hand totals per D-01
    const balanceMatch: any = {
      workspaceId: wsObj,
      firmId: firmObj,
      bucketType: 'stock',
    };
    if (query.godownId) {
      balanceMatch.godownId = new Types.ObjectId(query.godownId);
    }
    const balanceAgg = await this.balanceModel.aggregate([
      { $match: balanceMatch },
      { $group: { _id: '$itemId', onHand: { $sum: '$qty' } } },
    ]);
    const onHandMap = new Map<string, number>(
      balanceAgg.map((r) => [r._id.toString(), r.onHand]),
    );

    // 2) Item lookup with optional filters
    const itemFilter: any = {
      workspaceId: wsObj,
      firmId: firmObj,
      isDeleted: { $ne: true },
      trackStock: { $ne: false },
    };
    if (query.category) itemFilter.category = query.category;
    if (query.trackBatchOnly) itemFilter.trackBatch = true;
    if (query.q) {
      itemFilter.$or = [
        { name: { $regex: query.q, $options: 'i' } },
        { itemCode: { $regex: query.q, $options: 'i' } },
      ];
    }
    const items = await this.itemModel.find(itemFilter).lean();

    // 3) FIFO weighted-avg cost per item (only if firm uses fifo)
    const fifoCostMap = new Map<string, number>();
    if (valuationMethod === 'fifo') {
      const layerAgg = await this.layerModel.aggregate([
        {
          $match: {
            workspaceId: wsObj,
            firmId: firmObj,
            isExhausted: false,
            qtyRemaining: { $gt: 0 },
          },
        },
        {
          $group: {
            _id: '$itemId',
            totalQty: { $sum: '$qtyRemaining' },
            weightedCost: {
              $sum: { $multiply: ['$qtyRemaining', '$costPaise'] },
            },
          },
        },
      ]);
      for (const r of layerAgg) {
        if (r.totalQty > 0) {
          fifoCostMap.set(
            r._id.toString(),
            Math.round(r.weightedCost / r.totalQty),
          );
        }
      }
    }

    // 4) Lot counts + expiring-soon counts per item (single aggregation pass)
    const cutoff30d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const now = new Date();
    const lotAgg = await this.lotModel.aggregate([
      {
        $match: {
          workspaceId: wsObj,
          firmId: firmObj,
          isDeleted: false,
          qtyRemaining: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: '$itemId',
          lotCount: { $sum: 1 },
          expiringSoon: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$expiryDate', null] },
                    { $lte: ['$expiryDate', cutoff30d] },
                    { $gte: ['$expiryDate', now] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);
    const lotMap = new Map<
      string,
      { lotCount: number; expiringSoon: number }
    >();
    for (const r of lotAgg) {
      lotMap.set(r._id.toString(), {
        lotCount: r.lotCount,
        expiringSoon: r.expiringSoon,
      });
    }

    // 5) Build rows
    const rows: StockSummaryRow[] = items.map((it: any) => {
      const id = it._id.toString();
      const onHand = onHandMap.get(id) ?? 0;
      const reserved = it.reservedQty ?? 0;
      const reorderQty = it.reorderQty ?? 0;
      const avgCostPaise =
        valuationMethod === 'fifo'
          ? (fifoCostMap.get(id) ?? it.movingAvgCostPaise ?? 0)
          : (it.movingAvgCostPaise ?? 0);
      const stockValuePaise = Math.round(onHand * avgCostPaise);
      const lotInfo = lotMap.get(id) ?? { lotCount: 0, expiringSoon: 0 };

      return {
        itemId: id,
        itemCode: it.itemCode ?? '',
        name: it.name,
        categoryName: it.category,
        unitName: it.unit,
        reorderQty,
        onHandQty: onHand,
        reservedQty: reserved,
        availableQty: onHand - reserved,
        avgCostPaise,
        stockValuePaise,
        lotCount: lotInfo.lotCount,
        belowReorder: reorderQty > 0 && onHand < reorderQty,
        expiringSoonCount: lotInfo.expiringSoon,
      };
    });

    const filtered = query.lowStockOnly ? rows.filter((r) => r.belowReorder) : rows;

    const kpi = {
      totalSkus: filtered.length,
      totalStockValuePaise: filtered.reduce((s, r) => s + r.stockValuePaise, 0),
      itemsBelowReorder: filtered.filter((r) => r.belowReorder).length,
      lotsExpiringSoon: filtered.reduce((s, r) => s + r.expiringSoonCount, 0),
    };

    return { kpi, rows: filtered };
  }

  async findByItem(
    workspaceId: string,
    firmId: string,
    itemId: string,
  ): Promise<{
    item: any;
    perGodown: Array<{
      godownId: string;
      godownName?: string;
      bucketType: string;
      qty: number;
    }>;
    lots: Array<{
      lotId: string;
      lotNo: string;
      godownId: string;
      qtyRemaining: number;
      expiryDate?: Date;
    }>;
  }> {
    const wsObj = new Types.ObjectId(workspaceId);
    const firmObj = new Types.ObjectId(firmId);
    const itemObj = new Types.ObjectId(itemId);

    const item = await this.itemModel
      .findOne({ _id: itemObj, workspaceId: wsObj, firmId: firmObj })
      .lean();
    if (!item) return { item: null, perGodown: [], lots: [] };

    // Per-godown breakdown with godown name lookup via $lookup
    const balances = await this.balanceModel.aggregate([
      { $match: { workspaceId: wsObj, firmId: firmObj, itemId: itemObj } },
      {
        $lookup: {
          from: 'godowns',
          localField: 'godownId',
          foreignField: '_id',
          as: 'godown',
        },
      },
      {
        $unwind: { path: '$godown', preserveNullAndEmptyArrays: true },
      },
      {
        $project: {
          _id: 0,
          godownId: 1,
          bucketType: 1,
          qty: 1,
          godownName: '$godown.name',
        },
      },
    ]);

    const lots = await this.lotModel
      .find({
        workspaceId: wsObj,
        firmId: firmObj,
        itemId: itemObj,
        isDeleted: false,
        qtyRemaining: { $gt: 0 },
      })
      .select('lotNo godownId qtyRemaining expiryDate')
      .lean();

    return {
      item,
      perGodown: balances.map((b) => ({
        godownId: b.godownId.toString(),
        godownName: b.godownName,
        bucketType: b.bucketType,
        qty: b.qty,
      })),
      lots: lots.map((l: any) => ({
        lotId: l._id.toString(),
        lotNo: l.lotNo,
        godownId: l.godownId.toString(),
        qtyRemaining: l.qtyRemaining,
        expiryDate: l.expiryDate,
      })),
    };
  }
}
