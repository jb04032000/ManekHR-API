import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { WastageEntry, WastageEntryDocument } from './wastage-entry.schema';
import { Item } from '../../items/item.schema';
import { Document } from 'mongoose';
import { StockMovementsService } from '../stock-movements/stock-movements.service';
import { LedgerPostingService } from '../../sales/ledger-posting/ledger-posting.service';
import { VoucherSeriesService } from '../../voucher-series/voucher-series.service';
import { CreateWastageEntryDto } from './dto/create-wastage-entry.dto';
import { UpdateWastageEntryDto } from './dto/update-wastage-entry.dto';

type ItemDocument = Item & Document;

@Injectable()
export class WastageService {
  private readonly logger = new Logger(WastageService.name);

  constructor(
    @InjectModel(WastageEntry.name)
    private readonly wastageModel: Model<WastageEntryDocument>,
    @InjectModel(Item.name)
    private readonly itemModel: Model<ItemDocument>,
    @InjectConnection()
    private readonly connection: Connection,
    private readonly stockMovementsService: StockMovementsService,
    private readonly ledgerPostingService: LedgerPostingService,
    private readonly voucherSeriesService: VoucherSeriesService,
  ) {}

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Derives 2-digit FY string (e.g. "25-26") from a date using April as FY start. */
  private currentFinancialYear(date = new Date()): string {
    const y = date.getFullYear();
    const month = date.getMonth() + 1; // 1-based
    const startYear = month >= 4 ? y : y - 1;
    const endYear = startYear + 1;
    return `${startYear}-${String(endYear).slice(2)}`;
  }

  // ─── list ─────────────────────────────────────────────────────────────────

  async list(
    wsId: string,
    firmId: string,
    filters: { status?: string; from?: Date; to?: Date } = {},
  ) {
    const q: Record<string, any> = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };
    if (filters.status) q.status = filters.status;
    if (filters.from || filters.to) {
      q.date = {};
      if (filters.from) q.date.$gte = filters.from;
      if (filters.to) q.date.$lte = filters.to;
    }
    return this.wastageModel.find(q).sort({ date: -1, createdAt: -1 }).lean();
  }

  // ─── findById ─────────────────────────────────────────────────────────────

  async findById(wsId: string, firmId: string, id: string) {
    const doc = await this.wastageModel.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    });
    if (!doc) throw new NotFoundException('Wastage entry not found');
    return doc;
  }

  // ─── create ───────────────────────────────────────────────────────────────

  async create(
    wsId: string,
    firmId: string,
    dto: CreateWastageEntryDto,
    userId: string,
  ): Promise<WastageEntryDocument> {
    const fy = this.currentFinancialYear(new Date(dto.date));
    const voucherNo = await this.voucherSeriesService.generateNextNumber(
      firmId,
      'wastage_entry',
      fy,
    );

    const doc = await this.wastageModel.create({
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      voucherNo,
      date: new Date(dto.date),
      godownId: new Types.ObjectId(dto.godownId),
      lines: dto.lines.map((l) => ({
        itemId: new Types.ObjectId(l.itemId),
        lotId: l.lotId ? new Types.ObjectId(l.lotId) : undefined,
        batchId: l.batchId ? new Types.ObjectId(l.batchId) : undefined,
        qty: l.qty,
        wastageType: l.wastageType,
        reasonCode: l.reasonCode,
        remarks: l.remarks,
        costPaise: 0, // resolved at post time
      })),
      totalCostPaise: 0,
      narration: dto.narration,
      status: 'draft',
      auditLog: [{ at: new Date(), by: new Types.ObjectId(userId), action: 'created' }],
    });

    return doc;
  }

  // ─── update ───────────────────────────────────────────────────────────────

  async update(
    wsId: string,
    firmId: string,
    id: string,
    dto: UpdateWastageEntryDto,
    userId: string,
  ): Promise<WastageEntryDocument> {
    const existing = await this.findById(wsId, firmId, id);

    // T-09-06-04: Reject updates to posted entries
    if (existing.status === 'posted') {
      throw new ConflictException('Cannot update a posted wastage entry');
    }

    if (dto.date) existing.date = new Date(dto.date);
    if (dto.godownId) existing.godownId = new Types.ObjectId(dto.godownId);
    if (dto.lines) {
      (existing.lines as any) = dto.lines.map((l) => ({
        itemId: new Types.ObjectId(l.itemId),
        lotId: l.lotId ? new Types.ObjectId(l.lotId) : undefined,
        batchId: l.batchId ? new Types.ObjectId(l.batchId) : undefined,
        qty: l.qty,
        wastageType: l.wastageType,
        reasonCode: l.reasonCode,
        remarks: l.remarks,
        costPaise: 0,
      }));
    }
    if (dto.narration !== undefined) existing.narration = dto.narration;

    existing.auditLog.push({
      at: new Date(),
      by: new Types.ObjectId(userId),
      action: 'updated',
    });

    await existing.save();
    return existing;
  }

  // ─── post ─────────────────────────────────────────────────────────────────

  /**
   * Atomically posts a WastageEntry:
   *  1. Resolve per-line cost from Item.movingAvgCostPaise snapshot at time of post
   *  2. Record wastage_out StockMovement per line (negative qty)
   *  3. Post LedgerEntry (Dr 5018 / Cr 1004) for own_goods aggregate only (D-06)
   *  4. Flip status to 'posted', set postedBy / postedAt, push audit log
   *
   * All operations within one MongoDB session; abortTransaction rolls back everything.
   */
  async post(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
  ): Promise<WastageEntryDocument> {
    const wastage = await this.findById(wsId, firmId, id);

    // T-09-06-04: Guard against re-posting
    if (wastage.status === 'posted') {
      throw new ConflictException('Wastage entry already posted');
    }

    if (wastage.lines.length === 0) {
      throw new BadRequestException('Cannot post an empty wastage entry');
    }

    const session = await this.connection.startSession();
    session.startTransaction();

    try {
      // ── Step 1: Resolve per-line cost from Item.movingAvgCostPaise snapshot ──
      const uniqueItemIds = [...new Set(wastage.lines.map((l) => l.itemId.toString()))];
      const items = await this.itemModel
        .find(
          { _id: { $in: uniqueItemIds.map((i) => new Types.ObjectId(i)) } },
          null,
          { session },
        )
        .lean();

      // T-09-06-03: defensive ?? 0 to handle corrupted movingAvgCostPaise
      const itemCostMap = new Map<string, number>(
        items.map((item) => [item._id.toString(), (item as any).movingAvgCostPaise ?? 0]),
      );

      let ownGoodsTotalPaise = 0;

      // ── Step 2: Record wastage_out StockMovement per line ────────────────────
      for (const line of wastage.lines) {
        const unitCost = itemCostMap.get(line.itemId.toString()) ?? 0;
        const lineCost = unitCost * line.qty;

        // Mutate document in place — saved at end of transaction
        line.costPaise = lineCost;

        if (line.wastageType === 'own_goods') {
          ownGoodsTotalPaise += lineCost;
        }

        // negative qty = outward movement (unified sign convention per D-01)
        await this.stockMovementsService.record(
          {
            workspaceId: wsId,
            firmId,
            movementType: 'wastage_out',
            itemId: line.itemId.toString(),
            godownId: wastage.godownId.toString(),
            lotId: line.lotId?.toString(),
            batchId: line.batchId?.toString(),
            qty: -line.qty,
            costPaise: unitCost,
            sourceVoucherId: wastage._id.toString(),
            sourceVoucherType: 'wastage_entry',
            sourceVoucherNumber: wastage.voucherNo,
            narration: `Wastage: ${line.reasonCode}`,
          },
          userId,
          session,
        );
      }

      // Compute total (own_goods + job_work_material combined)
      wastage.totalCostPaise = wastage.lines.reduce((sum, l) => sum + l.costPaise, 0);

      // ── Step 3: Ledger entry for own_goods aggregate only (D-06) ─────────────
      // job_work_material: no ledger entry — material belongs to principal (D-06)
      // Set postedBy before postWastageEntry so the ledger entry captures the real userId
      wastage.postedBy = new Types.ObjectId(userId);
      const ledgerEntry = await this.ledgerPostingService.postWastageEntry(
        wastage,
        ownGoodsTotalPaise,
        session,
      );

      if (ledgerEntry) {
        wastage.ledgerEntryId = (ledgerEntry as any)._id;
      }

      // ── Step 4: Flip status ───────────────────────────────────────────────────
      wastage.status = 'posted';
      wastage.postedAt = new Date();
      wastage.auditLog.push({
        at: new Date(),
        by: new Types.ObjectId(userId),
        action: 'posted',
      });

      await wastage.save({ session });
      await session.commitTransaction();

      return wastage;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }

  // ─── createPosted ─────────────────────────────────────────────────────────

  /**
   * Creates a WastageEntry already in 'posted' state inside an existing transaction.
   *
   * Used by F-10 ManufacturingVoucherService.completeProduction when actual scrap
   * exceeds wastageAllowedPct — caller passes its own ClientSession; this method
   * MUST NOT open a new session (nested sessions throw MongoError).
   *
   * Behavior matches `create()` + `post()` combined, minus the session lifecycle.
   */
  async createPosted(
    wsId: string,
    firmId: string,
    dto: CreateWastageEntryDto,
    userId: string,
    session: ClientSession,
    sourceVoucher?: { id: string; type: string; number: string },
  ): Promise<WastageEntryDocument> {
    if (!session) {
      throw new BadRequestException('createPosted requires an external ClientSession');
    }
    if (!dto.lines || dto.lines.length === 0) {
      throw new BadRequestException('Cannot post an empty wastage entry');
    }
    if (dto.lines.some((l) => l.qty <= 0)) {
      throw new BadRequestException('All wastage lines must have qty > 0');
    }

    const fy = this.currentFinancialYear(new Date(dto.date));
    const voucherNo = await this.voucherSeriesService.generateNextNumber(
      firmId,
      'wastage_entry',
      fy,
    );

    // Resolve per-line cost from Item.movingAvgCostPaise inside the session
    const uniqueItemIds = [...new Set(dto.lines.map((l) => l.itemId.toString()))];
    const items = await this.itemModel
      .find(
        { _id: { $in: uniqueItemIds.map((i) => new Types.ObjectId(i)) } },
        null,
        { session },
      )
      .lean();
    const itemCostMap = new Map<string, number>(
      items.map((item) => [item._id.toString(), (item as any).movingAvgCostPaise ?? 0]),
    );

    // Build line array with resolved costs
    let ownGoodsTotalPaise = 0;
    const linesWithCost = dto.lines.map((l) => {
      const unitCost = itemCostMap.get(l.itemId.toString()) ?? 0;
      const lineCost = unitCost * l.qty;
      if (l.wastageType === 'own_goods') ownGoodsTotalPaise += lineCost;
      return {
        itemId: new Types.ObjectId(l.itemId),
        lotId: l.lotId ? new Types.ObjectId(l.lotId) : undefined,
        batchId: l.batchId ? new Types.ObjectId(l.batchId) : undefined,
        qty: l.qty,
        wastageType: l.wastageType,
        reasonCode: l.reasonCode,
        remarks: l.remarks,
        costPaise: lineCost,
      };
    });

    // Create the document inside the session
    const created = await this.wastageModel.create(
      [
        {
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          voucherNo,
          date: new Date(dto.date),
          godownId: new Types.ObjectId(dto.godownId),
          lines: linesWithCost,
          totalCostPaise: linesWithCost.reduce((s, l) => s + l.costPaise, 0),
          narration: dto.narration,
          status: 'posted',
          postedAt: new Date(),
          postedBy: new Types.ObjectId(userId),
          sourceVoucherId: sourceVoucher?.id ? new Types.ObjectId(sourceVoucher.id) : undefined,
          sourceVoucherType: sourceVoucher?.type,
          sourceVoucherNumber: sourceVoucher?.number,
          auditLog: [
            { at: new Date(), by: new Types.ObjectId(userId), action: 'created' },
            { at: new Date(), by: new Types.ObjectId(userId), action: 'posted' },
          ],
        },
      ],
      { session },
    );
    const wastage = created[0];

    // Record wastage_out StockMovement per line within the session
    // Use itemCostMap (movingAvgCostPaise) for unit cost — consistent with how linesWithCost
    // was built above, avoids division-by-zero, and keeps both code paths aligned.
    for (const line of wastage.lines) {
      const unitCost = itemCostMap.get(line.itemId.toString()) ?? 0;
      await this.stockMovementsService.record(
        {
          workspaceId: wsId,
          firmId,
          movementType: 'wastage_out',
          itemId: line.itemId.toString(),
          godownId: wastage.godownId.toString(),
          lotId: line.lotId?.toString(),
          batchId: line.batchId?.toString(),
          qty: -line.qty,
          costPaise: unitCost,
          sourceVoucherId: wastage._id.toString(),
          sourceVoucherType: 'wastage_entry',
          sourceVoucherNumber: wastage.voucherNo,
          narration: `Wastage (auto): ${line.reasonCode}`,
        },
        userId,
        session,
      );
    }

    // Post ledger entry for own_goods aggregate (job_work_material → no ledger per D-06)
    const ledgerEntry = await this.ledgerPostingService.postWastageEntry(
      wastage,
      ownGoodsTotalPaise,
      session,
    );
    if (ledgerEntry) {
      wastage.ledgerEntryId = (ledgerEntry as any)._id;
      await wastage.save({ session });
    }

    return wastage;
  }

  // ─── delete ───────────────────────────────────────────────────────────────

  async delete(
    wsId: string,
    firmId: string,
    id: string,
    userId: string,
  ): Promise<void> {
    const existing = await this.findById(wsId, firmId, id);

    // T-09-06-04: Reject deletion of posted entries
    if (existing.status === 'posted') {
      throw new ConflictException('Cannot delete a posted wastage entry');
    }

    await this.wastageModel.updateOne(
      { _id: existing._id },
      {
        $set: { isDeleted: true, deletedAt: new Date() },
        $push: {
          auditLog: {
            at: new Date(),
            by: new Types.ObjectId(userId),
            action: 'deleted',
          },
        },
      },
    );
  }
}
