import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Document, Model, Types } from 'mongoose';
import { ManufacturingVoucher, ManufacturingVoucherDocument } from './manufacturing-voucher.schema';
import { Firm } from '../../firms/firm.schema';
import { Item } from '../../items/item.schema';
import { BomService } from '../bom/bom.service';
import { StockMovementsService } from '../../inventory/stock-movements/stock-movements.service';
import { BatchesService } from '../../inventory/batches/batches.service';
import { LotsService } from '../../inventory/lots/lots.service';
import { GodownBalanceService } from '../../inventory/godown-balances/godown-balance.service';
import { VoucherSeriesService } from '../../voucher-series/voucher-series.service';
import { LedgerPostingService } from '../../sales/ledger-posting/ledger-posting.service';
import { WastageService } from '../../inventory/wastage/wastage.service';
import { CreateManufacturingVoucherDto } from './dto/create-manufacturing-voucher.dto';
import { IssueMaterialsDto } from './dto/issue-materials.dto';
import { CompleteProductionDto } from './dto/complete-production.dto';
import { ListManufacturingVouchersDto } from './dto/list-manufacturing-vouchers.dto';
import { FyLockService } from '../../fiscal-year/fy-lock.service';
import { buildLotSuggestion, LotLike, LotSuggestion } from './lot-suggestions.util';
import { fgMovementUnitCostPaise, perUnitStandardCostPaise } from './fg-costing.util';

type FirmDocument = Firm & Document;
type ItemDocument = Item & Document;

@Injectable()
export class ManufacturingVouchersService {
  constructor(
    @InjectModel(ManufacturingVoucher.name)
    private readonly mvModel: Model<ManufacturingVoucherDocument>,
    @InjectModel(Firm.name)
    private readonly firmModel: Model<FirmDocument>,
    @InjectModel(Item.name)
    private readonly itemModel: Model<ItemDocument>,
    @InjectConnection()
    private readonly connection: Connection,
    private readonly bomService: BomService,
    private readonly stockMovementsService: StockMovementsService,
    private readonly batchesService: BatchesService,
    private readonly lotsService: LotsService,
    private readonly godownBalanceService: GodownBalanceService,
    private readonly voucherSeriesService: VoucherSeriesService,
    private readonly ledgerPostingService: LedgerPostingService,
    private readonly wastageService: WastageService,
    private readonly fyLock: FyLockService,
  ) {}

  // ─── Private helpers ─────────────────────────────────────────────────────

  /**
   * Derives Indian financial year string (e.g. "2025-26") for a given date.
   * Indian FY: Apr 1 → Mar 31.
   */
  private currentFinancialYear(date: Date = new Date()): string {
    const year = date.getFullYear();
    const month = date.getMonth() + 1; // 1-based
    if (month >= 4) {
      return `${year}-${(year + 1).toString().slice(2)}`;
    }
    return `${year - 1}-${year.toString().slice(2)}`;
  }

  /**
   * Generates a batch number in the format: {itemCode}-BATCH-{YYYYMMDD}-{4-digit seq}
   * D-09: uses today's date + random 4-digit suffix. Collision-safe (Batch unique index).
   */
  private async generateBatchNo(firmId: string, finishedItemId: string): Promise<string> {
    const item = await this.itemModel.findById(new Types.ObjectId(finishedItemId)).lean();
    const code = (item as any)?.itemCode ?? finishedItemId.slice(-6).toUpperCase();
    const today = new Date();
    const yyyymmdd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    // Use millisecond-precision timestamp suffix instead of Math.random() to avoid the
    // 1-in-9000 collision probability that would cause an E11000 duplicate-key error inside
    // an open transaction with no retry logic.
    const seq = String(Date.now() % 10000).padStart(4, '0');
    return `${code}-BATCH-${yyyymmdd}-${seq}`;
  }

  /**
   * Internal findById that returns a full Mongoose document (not lean).
   * Used by write methods that need .save().
   */
  private async findByIdRaw(
    wsId: string,
    firmId: string,
    mvId: string,
  ): Promise<ManufacturingVoucherDocument> {
    const doc = await this.mvModel.findOne({
      _id: new Types.ObjectId(mvId),
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    });
    if (!doc) throw new NotFoundException(`ManufacturingVoucher ${mvId} not found`);
    return doc;
  }

  // ─── list ─────────────────────────────────────────────────────────────────

  async list(
    wsId: string,
    firmId: string,
    filters: ListManufacturingVouchersDto,
  ): Promise<ManufacturingVoucherDocument[]> {
    const q: Record<string, any> = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };
    if (filters.status) q.status = filters.status;
    if (filters.itemId) q.finishedItemId = new Types.ObjectId(filters.itemId);
    if (filters.from || filters.to) {
      q.voucherDate = {};
      if (filters.from) q.voucherDate.$gte = new Date(filters.from);
      if (filters.to) q.voucherDate.$lte = new Date(filters.to);
    }
    return (await this.mvModel
      .find(q)
      .sort({ voucherDate: -1, createdAt: -1 })
      .lean()) as unknown as ManufacturingVoucherDocument[];
  }

  // ─── findById ─────────────────────────────────────────────────────────────

  async findById(
    wsId: string,
    firmId: string,
    mvId: string,
  ): Promise<ManufacturingVoucherDocument> {
    const doc = (await this.mvModel
      .findOne({
        _id: new Types.ObjectId(mvId),
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .lean()) as unknown as ManufacturingVoucherDocument;

    if (!doc) throw new NotFoundException(`ManufacturingVoucher ${mvId} not found`);

    // D-06: For draft MVs, augment with lot suggestions per component (FIFO order).
    // The web form (ManufacturingVoucherForm) and `types/index.ts` expect an
    // ARRAY of { itemId, suggestions[] }; buildLotSuggestion handles the FIFO
    // filter/sort + field mapping so the shapes stay in lockstep.
    if (doc.status === 'draft' && doc.componentsPlanned?.length > 0) {
      const lotSuggestions: LotSuggestion[] = [];
      for (const c of doc.componentsPlanned) {
        const lots = await this.lotsService.list(wsId, firmId, {
          itemId: c.itemId.toString(),
        });
        lotSuggestions.push(buildLotSuggestion(c.itemId.toString(), lots as unknown as LotLike[]));
      }
      (doc as any).lotSuggestions = lotSuggestions;
    }

    return doc;
  }

  // ─── createDraft ──────────────────────────────────────────────────────────

  async createDraft(
    wsId: string,
    firmId: string,
    dto: CreateManufacturingVoucherDto,
    userId: string,
  ): Promise<ManufacturingVoucherDocument> {
    // F-15 Plan 03: FY-lock guard — DTO uses voucherDate or current date as fallback
    const voucherDate = (dto as any).voucherDate ? new Date((dto as any).voucherDate) : new Date();
    await this.fyLock.assertOpen(wsId, firmId, voucherDate);

    // Load BoM — validates ownership and existence
    const bom = await this.bomService.findById(wsId, firmId, dto.bomId);
    const scaleFactor = dto.finishedQty / bom.outputQty;

    // Build componentsPlanned snapshot from BoM
    let componentsPlanned: any[];
    if (dto.explodeSubAssemblies === true) {
      // D-04: full multi-level explosion to leaf components
      const exploded = await this.bomService.explode(wsId, firmId, dto.bomId, dto.finishedQty);
      componentsPlanned = exploded.map((e) => ({
        itemId: e.itemId,
        plannedQty: Math.round(e.requiredQty * 1000) / 1000, // preserve 3dp
        unit: e.unit,
        wastageAllowedPct: 0, // exploded leaf components: no wastage override at this level
      }));
    } else {
      // Copy immediate BoM components, scaling qty
      componentsPlanned = bom.components.map((c) => ({
        itemId: c.itemId,
        plannedQty: Math.round(c.qty * scaleFactor * 1000) / 1000,
        unit: c.unit,
        wastageAllowedPct: c.wastageAllowedPct ?? 0,
      }));
    }

    // Resolve or generate batch number (D-09)
    const batchNo =
      dto.batchNo ?? (await this.generateBatchNo(firmId, bom.finishedItemId.toString()));

    const docs = await this.mvModel.create([
      {
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        voucherNumber: '',
        voucherDate: new Date(dto.voucherDate),
        status: 'draft',
        bomId: new Types.ObjectId(dto.bomId),
        bomVersionNo: bom.versionNo,
        finishedItemId: bom.finishedItemId,
        finishedQty: dto.finishedQty,
        finishedUnit: bom.outputUnit,
        finishedGodownId: new Types.ObjectId(dto.finishedGodownId),
        batchNo,
        componentsPlanned,
        componentsConsumed: [],
        additionalCosts: (dto.additionalCosts ?? []).map((ac) => ({
          accountId: new Types.ObjectId(ac.accountId),
          amountPaise: ac.amountPaise,
          narration: ac.narration,
        })),
        byProductsProduced: [],
        costMethod: dto.costMethod ?? 'actual',
        totalInputCostPaise: 0,
        totalOutputCostPaise: 0,
        variancePaise: 0,
        actualFinishedQty: 0,
        ledgerEntryIds: [],
        narration: dto.narration,
        isDeleted: false,
        createdBy: new Types.ObjectId(userId),
      },
    ]);
    return docs[0];
  }

  // ─── update ───────────────────────────────────────────────────────────────

  async update(
    wsId: string,
    firmId: string,
    mvId: string,
    dto: Partial<{
      componentsPlanned: any[];
      finishedQty: number;
      additionalCosts: any[];
      narration: string;
      batchNo: string;
      costMethod: 'actual' | 'standard';
    }>,
    _userId: string,
  ): Promise<ManufacturingVoucherDocument> {
    const mv = await this.findByIdRaw(wsId, firmId, mvId);
    if (mv.status !== 'draft') {
      throw new ConflictException('MV_NOT_DRAFT');
    }

    if (dto.componentsPlanned !== undefined) {
      mv.componentsPlanned = dto.componentsPlanned;
    }
    if (dto.finishedQty !== undefined) mv.finishedQty = dto.finishedQty;
    if (dto.additionalCosts !== undefined) {
      mv.additionalCosts = dto.additionalCosts.map((ac) => ({
        accountId: new Types.ObjectId(ac.accountId),
        amountPaise: ac.amountPaise,
        narration: ac.narration,
      })) as any;
    }
    if (dto.narration !== undefined) mv.narration = dto.narration;
    if (dto.batchNo !== undefined) mv.batchNo = dto.batchNo;
    if (dto.costMethod !== undefined) mv.costMethod = dto.costMethod;

    await mv.save();
    return mv;
  }

  // ─── issueMaterials ───────────────────────────────────────────────────────

  /**
   * Atomic transition: draft → in_progress.
   *
   * Steps (all inside one MongoDB session):
   * 1. Assign voucher number (VoucherSeries — D-10)
   * 2. Build componentsConsumed with actual cost snapshot (Item.movingAvgCostPaise)
   * 3. Record manufacturing_out StockMovements (negative qty) per component
   * 4. Post WIP / Raw Material ledger entry (Dr 1011 / Cr 1010)
   * 5. Create Batch record (qtyProduced=0, bomId set — D-09)
   * 6. Flip status to in_progress
   *
   * T-F10-W4-01: Pre-issue balance check (INSUFFICIENT_STOCK unless allowNegativeStock=true)
   * T-F10-W4-02: Status guard (MV_NOT_DRAFT)
   * T-F10-W4-08: Replay guard (same as T-F10-W4-02 — one-way transition)
   */
  async issueMaterials(
    wsId: string,
    firmId: string,
    mvId: string,
    dto: IssueMaterialsDto,
    userId: string,
  ): Promise<ManufacturingVoucherDocument> {
    const mv = await this.findByIdRaw(wsId, firmId, mvId);

    // F-15 Plan 03: FY-lock guard
    await this.fyLock.assertOpen(
      wsId,
      firmId,
      (mv as any).issuedAt ?? (mv as any).voucherDate ?? new Date(),
    );

    // T-F10-W4-02: State machine guard
    if (mv.status !== 'draft') {
      throw new ConflictException('MV_NOT_DRAFT');
    }

    // T-F10-W4-01: Stock availability check
    const firm = await this.firmModel
      .findOne({
        _id: new Types.ObjectId(firmId),
        workspaceId: new Types.ObjectId(wsId),
        isDeleted: false,
      })
      .lean();
    const allowNegative = (firm as any)?.allowNegativeStock === true;

    if (!allowNegative) {
      // Aggregate the required qty per (item, godown) first: two component lines
      // for the same item+godown would each pass an independent balance check yet
      // together overdraw the stock, defeating the negative-stock guard.
      const neededByKey = new Map<string, { itemId: string; godownId: string; qty: number }>();
      for (const c of dto.componentsConsumed) {
        const key = `${c.itemId}::${c.godownId}`;
        const prev = neededByKey.get(key);
        neededByKey.set(key, {
          itemId: c.itemId,
          godownId: c.godownId,
          qty: (prev?.qty ?? 0) + c.qty,
        });
      }
      for (const need of neededByKey.values()) {
        const balance = await this.godownBalanceService.getBalance(
          wsId,
          firmId,
          need.itemId,
          need.godownId,
        );
        if (balance < need.qty) {
          throw new BadRequestException({
            code: 'INSUFFICIENT_STOCK',
            message: `Item ${need.itemId} godown ${need.godownId}: needed ${need.qty}, have ${balance}`,
          });
        }
      }
    }

    // Resolve moving-avg cost per item for snapshot
    const itemIds = [...new Set(dto.componentsConsumed.map((c) => c.itemId))];
    const items = await this.itemModel
      .find({ _id: { $in: itemIds.map((i) => new Types.ObjectId(i)) } })
      .lean();
    const costMap = new Map<string, number>(
      items.map((i) => [i._id.toString(), (i as any).movingAvgCostPaise ?? 0]),
    );

    const session: ClientSession = await this.connection.startSession();
    session.startTransaction();

    try {
      // 1. Assign voucher number (D-10)
      const fy = this.currentFinancialYear(mv.voucherDate);
      mv.voucherNumber = await this.voucherSeriesService.generateNextNumber(
        firmId,
        'manufacturing_voucher',
        fy,
      );

      // 2. Build componentsConsumed with cost snapshot
      mv.componentsConsumed = dto.componentsConsumed.map((c) => ({
        itemId: new Types.ObjectId(c.itemId),
        qty: c.qty,
        unit: c.unit,
        godownId: new Types.ObjectId(c.godownId),
        lotId: c.lotId ? new Types.ObjectId(c.lotId) : undefined,
        batchId: c.batchId ? new Types.ObjectId(c.batchId) : undefined,
        serialNos: c.serialNos,
        costAtConsumptionPaise: costMap.get(c.itemId) ?? 0,
      })) as any;

      mv.totalInputCostPaise =
        mv.componentsConsumed.reduce(
          (s, c) => s + Math.round(c.costAtConsumptionPaise * c.qty),
          0,
        ) + mv.additionalCosts.reduce((s, a) => s + a.amountPaise, 0);

      // 3. Record manufacturing_out StockMovement per component (negative qty = outward)
      for (const c of mv.componentsConsumed) {
        await this.stockMovementsService.record(
          {
            workspaceId: wsId,
            firmId,
            movementType: 'manufacturing_out',
            itemId: c.itemId.toString(),
            godownId: c.godownId.toString(),
            lotId: c.lotId?.toString(),
            batchId: c.batchId?.toString(),
            serialNos: c.serialNos,
            qty: -c.qty, // negative = outward
            costPaise: c.costAtConsumptionPaise,
            sourceVoucherId: mv._id.toString(),
            sourceVoucherType: 'manufacturing_voucher',
            sourceVoucherNumber: mv.voucherNumber,
            narration: `Issued for MV ${mv.voucherNumber}`,
          },
          userId,
          session,
        );
      }

      // 4. Set audit fields before ledger posting (postManufacturingIssue reads them)
      mv.issuedAt = new Date();
      mv.issuedBy = new Types.ObjectId(userId);

      // 5. Post WIP / Raw Material ledger entry
      const issueEntry = await this.ledgerPostingService.postManufacturingIssue(mv, session);
      mv.ledgerEntryIds = [(issueEntry as any)._id as Types.ObjectId];

      // 6. Create Batch record (qtyProduced=0 at this stage — D-09)
      const batchNo =
        mv.batchNo ?? (await this.generateBatchNo(firmId, mv.finishedItemId.toString()));
      const batch = await this.batchesService.create(
        wsId,
        firmId,
        {
          itemId: mv.finishedItemId.toString(),
          batchNo,
          qtyProduced: 0,
          godownId: mv.finishedGodownId.toString(),
          bomId: mv.bomId.toString(),
        } as any,
        session,
      );
      mv.batchRecordId = (batch as any)._id as Types.ObjectId;
      mv.batchNo = batchNo;

      // 7. Transition to in_progress
      mv.status = 'in_progress';
      await mv.save({ session });
      await session.commitTransaction();
      return mv;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }

  // ─── completeProduction ───────────────────────────────────────────────────

  /**
   * Atomic transition: in_progress → completed.
   *
   * Steps (all inside one MongoDB session):
   * a. Compute by-product NRV cost from BoM (lookup current BoM by bomId)
   * b. Record manufacturing_in StockMovement for FG (positive qty)
   * c. Record manufacturing_in per by-product
   * d. Update Batch: qtyProduced = actualFinishedQty, mfgDate = now
   * e. Detect excess scrap per component vs allowed wastage
   * f. Auto-create WastageEntry for excess scrap (WastageService.createPosted)
   * g. Set completedAt / completedBy
   * h. Post FG / Variance / WIP ledger entry (Dr 1012 / Dr 5060 / Cr 1011)
   * i. Flip status to completed
   *
   * T-F10-W4-02: Status guard (must be in_progress)
   * T-F10-W4-07: Cancel-completed guard (handled in cancel())
   */
  async completeProduction(
    wsId: string,
    firmId: string,
    mvId: string,
    dto: CompleteProductionDto,
    userId: string,
  ): Promise<ManufacturingVoucherDocument> {
    const mv = await this.findByIdRaw(wsId, firmId, mvId);

    // F-15 Plan 03: FY-lock guard
    await this.fyLock.assertOpen(
      wsId,
      firmId,
      (mv as any).completedAt ?? (mv as any).voucherDate ?? new Date(),
    );

    if (mv.status !== 'in_progress') {
      throw new ConflictException('MV must be in_progress to complete production');
    }

    // Load BoM for by-product NRV data
    const bom = await this.bomService.findById(wsId, firmId, mv.bomId.toString());

    const session: ClientSession = await this.connection.startSession();
    session.startTransaction();

    try {
      const now = new Date();

      // a. Build byProductsProduced with NRV cost from BoM
      mv.byProductsProduced = (dto.byProductsProduced ?? []).map((bp) => {
        const bomBp = bom.byProducts.find((b) => b.itemId.toString() === bp.itemId);
        const nrvPaisePerUnit = bomBp?.nrvPaisePerUnit ?? 0;
        return {
          itemId: new Types.ObjectId(bp.itemId),
          qty: bp.qty,
          unit: bp.unit,
          godownId: new Types.ObjectId(bp.godownId),
          costAllocatedPaise: Math.round(nrvPaisePerUnit * bp.qty),
        };
      }) as any;

      // a2. Standard costing: lock the per-unit standard FG cost from the BoM so
      // the completion ledger can post the actual-vs-standard variance (it reads
      // mv.standardFgCostPaise). Source is the BoM's deliberate cached standard
      // cost (set via GET /standard-cost), falling back to an on-demand rollup of
      // component moving-average costs. Per-unit = batch standard / outputQty.
      if (mv.costMethod === 'standard') {
        let batchStandardPaise = bom.standardCostPaise;
        if (batchStandardPaise === undefined || batchStandardPaise === null) {
          const computed = await this.bomService.computeStandardCost(
            wsId,
            firmId,
            mv.bomId.toString(),
          );
          batchStandardPaise = computed.standardCostPaise;
        }
        mv.standardFgCostPaise = perUnitStandardCostPaise(batchStandardPaise, bom.outputQty);
      }

      // b. Record manufacturing_in for Finished Goods (positive qty = inward).
      // In actual mode FG is costed NET of by-product NRV so the FG inventory
      // layer matches the completion ledger's FG debit (totalInputCost -
      // byProductNrv); costing at the full input cost would overstate FG whenever
      // the BoM has by-products. In standard mode FG is valued at the per-unit
      // standard cost (the variance line absorbs the difference), again matching
      // the ledger. byProductsProduced (with NRV) is built in step a above.
      const byProductNrvPaise = (mv.byProductsProduced ?? []).reduce(
        (s, b) => s + (b.costAllocatedPaise ?? 0),
        0,
      );
      await this.stockMovementsService.record(
        {
          workspaceId: wsId,
          firmId,
          movementType: 'manufacturing_in',
          itemId: mv.finishedItemId.toString(),
          godownId: mv.finishedGodownId.toString(),
          batchId: mv.batchRecordId?.toString(),
          qty: dto.actualFinishedQty,
          costPaise: fgMovementUnitCostPaise({
            costMethod: mv.costMethod,
            totalInputCostPaise: mv.totalInputCostPaise,
            byProductNrvPaise,
            actualFinishedQty: dto.actualFinishedQty,
            standardFgCostPaise: mv.standardFgCostPaise,
          }),
          sourceVoucherId: mv._id.toString(),
          sourceVoucherType: 'manufacturing_voucher',
          sourceVoucherNumber: mv.voucherNumber,
          narration: `FG receipt for MV ${mv.voucherNumber}`,
        },
        userId,
        session,
      );

      // c. Record manufacturing_in per by-product
      for (const bp of mv.byProductsProduced) {
        if (bp.qty > 0) {
          await this.stockMovementsService.record(
            {
              workspaceId: wsId,
              firmId,
              movementType: 'manufacturing_in',
              itemId: bp.itemId.toString(),
              godownId: bp.godownId.toString(),
              qty: bp.qty,
              costPaise: bp.qty > 0 ? Math.round(bp.costAllocatedPaise / bp.qty) : 0,
              sourceVoucherId: mv._id.toString(),
              sourceVoucherType: 'manufacturing_voucher',
              sourceVoucherNumber: mv.voucherNumber,
              narration: `By-product receipt for MV ${mv.voucherNumber}`,
            },
            userId,
            session,
          );
        }
      }

      // d. Update Batch: finalize qtyProduced, mfgDate
      if (mv.batchRecordId) {
        await this.batchesService.update(
          wsId,
          firmId,
          mv.batchRecordId.toString(),
          {
            qtyProduced: dto.actualFinishedQty,
            qtyRemaining: dto.actualFinishedQty,
            mfgDate: now,
          },
          session,
        );
      }

      // e. Detect excess scrap per component vs allowed wastage (D-08)
      const excessScrapLines: Array<{
        itemId: string;
        qty: number;
        godownId: string;
      }> = [];

      for (const consumed of mv.componentsConsumed) {
        const planned = mv.componentsPlanned.find(
          (p) => p.itemId.toString() === consumed.itemId.toString(),
        );
        if (!planned) continue;

        const allowedScrap = planned.plannedQty * ((planned.wastageAllowedPct ?? 0) / 100);
        const actualScrap = consumed.qty - planned.plannedQty;

        if (actualScrap > allowedScrap) {
          excessScrapLines.push({
            itemId: consumed.itemId.toString(),
            qty: actualScrap - allowedScrap,
            godownId: consumed.godownId.toString(),
          });
        }
      }

      // f. Auto-create WastageEntry for excess scrap (Pitfall 4: use createPosted, not post())
      // Group scrap lines by their source godownId so each WastageEntry's stock movements
      // decrement the correct godown rather than always using the first component's godown.
      if (excessScrapLines.length > 0) {
        const scrapByGodown = new Map<string, typeof excessScrapLines>();
        for (const scrapLine of excessScrapLines) {
          const gid =
            scrapLine.godownId ??
            mv.componentsConsumed[0]?.godownId?.toString() ??
            mv.finishedGodownId.toString();
          const existing = scrapByGodown.get(gid) ?? [];
          existing.push(scrapLine);
          scrapByGodown.set(gid, existing);
        }

        for (const [godownId, lines] of scrapByGodown) {
          await this.wastageService.createPosted(
            wsId,
            firmId,
            {
              date: now.toISOString(),
              godownId,
              lines: lines.map((l) => ({
                itemId: l.itemId,
                qty: l.qty,
                wastageType: 'own_goods' as const,
                reasonCode: 'manufacturing_damage' as const,
                remarks: `Excess scrap from MV ${mv.voucherNumber}`,
              })),
              narration: `Excess scrap from MV ${mv.voucherNumber}`,
            },
            userId,
            session,
            {
              id: mv._id.toString(),
              type: 'manufacturing_voucher',
              number: mv.voucherNumber,
            },
          );
        }
      }

      // g. Set audit fields
      mv.actualFinishedQty = dto.actualFinishedQty;
      mv.completedAt = now;
      mv.completedBy = new Types.ObjectId(userId);
      if (dto.narration) mv.narration = dto.narration;

      // h. Post FG / Variance / WIP ledger entry
      // postManufacturingCompletion mutates mv.variancePaise + mv.totalOutputCostPaise
      const completionEntry = await this.ledgerPostingService.postManufacturingCompletion(
        mv,
        session,
      );
      mv.ledgerEntryIds = [
        ...(mv.ledgerEntryIds ?? []),
        (completionEntry as any)._id as Types.ObjectId,
      ];

      // i. Flip status
      mv.status = 'completed';
      await mv.save({ session });
      await session.commitTransaction();
      return mv;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }

  // ─── cancel ───────────────────────────────────────────────────────────────

  /**
   * Cancel a ManufacturingVoucher.
   *
   * From draft: simple status flip — no ledger / stock side effects.
   * From in_progress (atomic session):
   *   a. Reverse each manufacturing_out with a manufacturing_in (positive qty)
   *   b. Post ledger reversal (flips the issue entry)
   *   c. Soft-delete the Batch
   *   d. Flip status to cancelled
   *
   * T-F10-W4-07: Cannot cancel a completed MV.
   * T-F10-W4-03: cancelledAt + cancelledBy set for audit trail.
   */
  async cancel(
    wsId: string,
    firmId: string,
    mvId: string,
    userId: string,
  ): Promise<ManufacturingVoucherDocument> {
    const mv = await this.findByIdRaw(wsId, firmId, mvId);

    // F-15 Plan 03: FY-lock guard
    await this.fyLock.assertOpen(wsId, firmId, (mv as any).voucherDate ?? new Date());

    // T-F10-W4-07: Prevent cancel of completed MV
    if (mv.status === 'completed') {
      throw new ConflictException('MV_CANNOT_CANCEL_COMPLETED');
    }

    const now = new Date();
    mv.cancelledAt = now;
    mv.cancelledBy = new Types.ObjectId(userId);

    if (mv.status === 'draft') {
      // Draft cancel: no side effects
      mv.status = 'cancelled';
      await mv.save();
      return mv;
    }

    // in_progress cancel: atomic session
    const session: ClientSession = await this.connection.startSession();
    session.startTransaction();

    try {
      // a. Reverse each manufacturing_out with manufacturing_in (positive qty)
      for (const c of mv.componentsConsumed) {
        await this.stockMovementsService.record(
          {
            workspaceId: wsId,
            firmId,
            movementType: 'manufacturing_in',
            itemId: c.itemId.toString(),
            godownId: c.godownId.toString(),
            lotId: c.lotId?.toString(),
            batchId: c.batchId?.toString(),
            serialNos: c.serialNos,
            qty: c.qty, // positive = returning to stock
            costPaise: c.costAtConsumptionPaise,
            sourceVoucherId: mv._id.toString(),
            sourceVoucherType: 'manufacturing_voucher',
            sourceVoucherNumber: mv.voucherNumber,
            narration: `Cancellation of MV ${mv.voucherNumber}`,
          },
          userId,
          session,
        );
      }

      // b. Post ledger reversal of the issue entry
      if (mv.ledgerEntryIds?.length > 0) {
        const reversalEntry = await this.ledgerPostingService.postManufacturingReversal(
          mv,
          mv.ledgerEntryIds[0],
          session,
        );
        mv.ledgerEntryIds = [
          ...(mv.ledgerEntryIds ?? []),
          (reversalEntry as any)._id as Types.ObjectId,
        ];
      }

      // c. Soft-delete the Batch
      if (mv.batchRecordId) {
        await this.batchesService.softDelete(wsId, firmId, mv.batchRecordId.toString(), session);
      }

      // d. Flip status
      mv.status = 'cancelled';
      await mv.save({ session });
      await session.commitTransaction();
      return mv;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }

  // ─── register ─────────────────────────────────────────────────────────────

  /**
   * Manufacturing register summary for D-15.
   * Returns all MVs matching filters with totals over completed MVs.
   */
  async register(
    wsId: string,
    firmId: string,
    filters: ListManufacturingVouchersDto,
  ): Promise<{
    items: ManufacturingVoucherDocument[];
    totals: {
      count: number;
      completedCount: number;
      totalInputPaise: number;
      totalVariancePaise: number;
    };
  }> {
    const items = await this.list(wsId, firmId, filters);
    const completed = items.filter((mv) => mv.status === 'completed');

    return {
      items,
      totals: {
        count: items.length,
        completedCount: completed.length,
        totalInputPaise: completed.reduce((s, mv) => s + (mv.totalInputCostPaise ?? 0), 0),
        totalVariancePaise: completed.reduce((s, mv) => s + (mv.variancePaise ?? 0), 0),
      },
    };
  }
}
