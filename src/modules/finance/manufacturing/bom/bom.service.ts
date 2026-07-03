import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Document, Model, Types } from 'mongoose';
import { BomComponent, BomDefinition, BomDefinitionDocument } from './bom.schema';
import { CreateBomDto, BomComponentDto } from './dto/create-bom.dto';
import { UpdateBomDto } from './dto/update-bom.dto';
import { ListBomDto } from './dto/list-bom.dto';
import { Item } from '../../items/item.schema';

// ─── Exploded component result type ──────────────────────────────────────────

export interface ExplodedComponent {
  itemId: Types.ObjectId;
  requiredQty: number;
  unit: string;
  level: number;
  path: string;
}

// ─── BomService ───────────────────────────────────────────────────────────────

@Injectable()
export class BomService {
  constructor(
    @InjectModel(BomDefinition.name)
    private readonly bomModel: Model<BomDefinitionDocument>,
    @InjectModel(Item.name)
    private readonly itemModel: Model<Item & Document>,
    @InjectModel('ManufacturingVoucher')
    private readonly mvModel: Model<any>,
  ) {}

  // ─── list ─────────────────────────────────────────────────────────────────

  async list(
    wsId: string,
    firmId: string,
    filters: ListBomDto,
  ): Promise<BomDefinitionDocument[]> {
    const query: Record<string, unknown> = {
      workspaceId: new Types.ObjectId(wsId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };

    if (filters.itemId) {
      query.finishedItemId = new Types.ObjectId(filters.itemId);
    }
    if (filters.isActive !== undefined) {
      query.isActive = filters.isActive;
    }
    if (filters.isDefault !== undefined) {
      query.isDefault = filters.isDefault;
    }

    return this.bomModel
      .find(query)
      .sort({ createdAt: -1 })
      .lean() as unknown as BomDefinitionDocument[];
  }

  // ─── findById ──────────────────────────────────────────────────────────────

  async findById(
    wsId: string,
    firmId: string,
    bomId: string,
  ): Promise<BomDefinitionDocument> {
    const bom = await this.bomModel
      .findOne({
        _id: new Types.ObjectId(bomId),
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .lean();

    if (!bom) {
      throw new NotFoundException(`BoM ${bomId} not found`);
    }

    return bom as unknown as BomDefinitionDocument;
  }

  // ─── create ───────────────────────────────────────────────────────────────

  async create(
    wsId: string,
    firmId: string,
    dto: CreateBomDto,
    userId: string,
  ): Promise<BomDefinitionDocument> {
    // Circular-reference guard before insert
    await this.detectCircularRef(dto.finishedItemId, dto.components);

    // isDefault enforcement: clear existing defaults atomically (Pitfall 5)
    if (dto.isDefault === true) {
      await this.bomModel.updateMany(
        {
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          finishedItemId: new Types.ObjectId(dto.finishedItemId),
          isDefault: true,
          isDeleted: false,
        },
        { $set: { isDefault: false } },
      );
    }

    const components = dto.components.map((c, i) => ({
      itemId: new Types.ObjectId(c.itemId),
      qty: c.qty,
      unit: c.unit,
      wastageAllowedPct: c.wastageAllowedPct ?? 0,
      isSubAssembly: c.isSubAssembly ?? false,
      subBomId: c.subBomId ? new Types.ObjectId(c.subBomId) : undefined,
      sortOrder: c.sortOrder ?? i,
    }));

    const byProducts = (dto.byProducts ?? []).map((bp) => ({
      itemId: new Types.ObjectId(bp.itemId),
      qty: bp.qty,
      unit: bp.unit,
      nrvPaisePerUnit: bp.nrvPaisePerUnit,
    }));

    const [created] = await this.bomModel.create([
      {
        workspaceId: new Types.ObjectId(wsId),
        firmId: new Types.ObjectId(firmId),
        finishedItemId: new Types.ObjectId(dto.finishedItemId),
        outputQty: dto.outputQty,
        outputUnit: dto.outputUnit,
        yieldPct: dto.yieldPct ?? 100,
        versionNo: 1,
        isDefault: dto.isDefault ?? false,
        isActive: true,
        components,
        byProducts,
        additionalCostEstimate: dto.additionalCostEstimate,
        narration: dto.narration,
        isDeleted: false,
        createdBy: new Types.ObjectId(userId),
        updatedBy: new Types.ObjectId(userId),
      },
    ]);

    return created;
  }

  // ─── update ───────────────────────────────────────────────────────────────

  async update(
    wsId: string,
    firmId: string,
    bomId: string,
    dto: UpdateBomDto,
    userId: string,
  ): Promise<BomDefinitionDocument> {
    const existing = await this.findById(wsId, firmId, bomId);

    // Circular-reference guard when components or finishedItemId changes.
    // Must also run when only finishedItemId changes (no component replacement) so that
    // a new finished item that already appears in a sub-BOM chain is caught immediately.
    if (dto.components || dto.finishedItemId) {
      const finishedItemId = dto.finishedItemId ?? existing.finishedItemId.toString();
      const components = dto.components ?? (existing.components as unknown as BomComponentDto[]);
      await this.detectCircularRef(finishedItemId, components);
    }

    // isDefault enforcement: clear existing defaults atomically before updating this doc
    if (dto.isDefault === true) {
      const finishedItemId = dto.finishedItemId
        ? new Types.ObjectId(dto.finishedItemId)
        : existing.finishedItemId;

      await this.bomModel.updateMany(
        {
          workspaceId: new Types.ObjectId(wsId),
          firmId: new Types.ObjectId(firmId),
          finishedItemId,
          isDefault: true,
          isDeleted: false,
          _id: { $ne: new Types.ObjectId(bomId) },
        },
        { $set: { isDefault: false } },
      );
    }

    // Build update payload
    const updatePayload: Record<string, unknown> = {
      versionNo: existing.versionNo + 1,
      updatedBy: new Types.ObjectId(userId),
    };

    if (dto.finishedItemId !== undefined) {
      updatePayload.finishedItemId = new Types.ObjectId(dto.finishedItemId);
    }
    if (dto.outputQty !== undefined) updatePayload.outputQty = dto.outputQty;
    if (dto.outputUnit !== undefined) updatePayload.outputUnit = dto.outputUnit;
    if (dto.yieldPct !== undefined) updatePayload.yieldPct = dto.yieldPct;
    if (dto.isDefault !== undefined) updatePayload.isDefault = dto.isDefault;
    if (dto.narration !== undefined) updatePayload.narration = dto.narration;
    if (dto.additionalCostEstimate !== undefined) {
      updatePayload.additionalCostEstimate = dto.additionalCostEstimate;
    }

    if (dto.components !== undefined) {
      updatePayload.components = dto.components.map((c, i) => ({
        itemId: new Types.ObjectId(c.itemId),
        qty: c.qty,
        unit: c.unit,
        wastageAllowedPct: c.wastageAllowedPct ?? 0,
        isSubAssembly: c.isSubAssembly ?? false,
        subBomId: c.subBomId ? new Types.ObjectId(c.subBomId) : undefined,
        sortOrder: c.sortOrder ?? i,
      }));
    }

    if (dto.byProducts !== undefined) {
      updatePayload.byProducts = dto.byProducts.map((bp) => ({
        itemId: new Types.ObjectId(bp.itemId),
        qty: bp.qty,
        unit: bp.unit,
        nrvPaisePerUnit: bp.nrvPaisePerUnit,
      }));
    }

    const updated = await this.bomModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(bomId), isDeleted: false },
        { $set: updatePayload },
        { new: true },
      )
      .lean();

    if (!updated) {
      throw new NotFoundException(`BoM ${bomId} not found`);
    }

    return updated as unknown as BomDefinitionDocument;
  }

  // ─── delete ───────────────────────────────────────────────────────────────

  async delete(
    wsId: string,
    firmId: string,
    bomId: string,
    userId: string,
  ): Promise<void> {
    // Guard: reject delete if any in-progress Manufacturing Vouchers reference this BoM
    if (this.mvModel) {
      try {
        const inUse = await this.mvModel.exists({
          bomId: new Types.ObjectId(bomId),
          status: { $in: ['draft', 'in_progress'] },
          isDeleted: false,
        });
        if (inUse) {
          throw new ConflictException('BOM_IN_USE');
        }
      } catch (err) {
        // Re-throw ConflictException as-is; swallow collection-not-found errors
        // when ManufacturingVoucher collection doesn't yet exist (Wave 2 standalone)
        if (err instanceof ConflictException) throw err;
        // Namespace/collection-not-found errors from placeholder schema — safe to ignore
      }
    }

    // Verify the BoM exists and belongs to this workspace/firm
    await this.findById(wsId, firmId, bomId);

    // Soft delete
    await this.bomModel.updateOne(
      { _id: new Types.ObjectId(bomId) },
      { $set: { isDeleted: true, deletedAt: new Date(), updatedBy: new Types.ObjectId(userId) } },
    );
  }

  // ─── explode ──────────────────────────────────────────────────────────────

  async explode(
    wsId: string,
    firmId: string,
    bomId: string,
    requestedQty?: number,
    depth = 0,
    visited = new Set<string>(),
  ): Promise<ExplodedComponent[]> {
    if (depth > 10) {
      throw new BadRequestException('BOM_MAX_DEPTH_EXCEEDED');
    }

    const bom = await this.findById(wsId, firmId, bomId);
    const effectiveQty = requestedQty ?? bom.outputQty;
    const scaleFactor = effectiveQty / bom.outputQty;
    const bomIdStr = (bom as any)._id.toString();

    if (visited.has(bomIdStr)) {
      throw new BadRequestException('CIRCULAR_BOM_REFERENCE');
    }
    visited.add(bomIdStr);

    const results: ExplodedComponent[] = [];

    for (const component of bom.components) {
      const scaledQty = component.qty * scaleFactor;

      if (component.isSubAssembly && component.subBomId) {
        // Recurse into sub-assembly BoM
        const subBomId = component.subBomId.toString();
        const childVisited = new Set(visited);
        const childResults = await this.explode(
          wsId,
          firmId,
          subBomId,
          scaledQty,
          depth + 1,
          childVisited,
        );
        results.push(...childResults);
      } else {
        // Leaf-level raw material
        results.push({
          itemId: component.itemId,
          requiredQty: scaledQty,
          unit: component.unit,
          level: depth + 1,
          path: component.itemId.toString(),
        });
      }
    }

    return results;
  }

  // ─── computeStandardCost ──────────────────────────────────────────────────

  async computeStandardCost(
    wsId: string,
    firmId: string,
    bomId: string,
    persist = false,
  ): Promise<{
    standardCostPaise: number;
    breakdown: Array<{
      itemId: string;
      qty: number;
      unitCostPaise: number;
      lineCostPaise: number;
    }>;
  }> {
    const bom = await this.findById(wsId, firmId, bomId);

    const itemIds = bom.components.map((c) => c.itemId);
    const items = await this.itemModel
      .find({ _id: { $in: itemIds } })
      .lean();

    const itemMap = new Map<string, number>();
    for (const item of items) {
      itemMap.set((item._id as Types.ObjectId).toString(), item.movingAvgCostPaise ?? 0);
    }

    const breakdown: Array<{
      itemId: string;
      qty: number;
      unitCostPaise: number;
      lineCostPaise: number;
    }> = [];

    let componentTotalPaise = 0;

    for (const component of bom.components) {
      const unitCostPaise = itemMap.get(component.itemId.toString()) ?? 0;
      const lineCostPaise = Math.round(component.qty * unitCostPaise);
      componentTotalPaise += lineCostPaise;

      breakdown.push({
        itemId: component.itemId.toString(),
        qty: component.qty,
        unitCostPaise,
        lineCostPaise,
      });
    }

    // Apply yield adjustment: divide by yield fraction (e.g., 95% yield → /0.95)
    const yieldFraction = (bom.yieldPct || 100) / 100;
    let standardCostPaise = Math.round(componentTotalPaise / yieldFraction);

    // Add overhead estimate
    standardCostPaise += bom.additionalCostEstimate ?? 0;
    standardCostPaise = Math.round(standardCostPaise);

    if (persist) {
      await this.bomModel.updateOne(
        { _id: new Types.ObjectId(bomId) },
        { $set: { standardCostPaise } },
      );
    }

    return { standardCostPaise, breakdown };
  }

  // ─── detectCircularRef (private) ─────────────────────────────────────────

  private async detectCircularRef(
    finishedItemId: string,
    components: BomComponentDto[] | BomComponent[],
    visitedItems = new Set<string>(),
    depth = 0,
  ): Promise<void> {
    if (depth > 10) {
      throw new BadRequestException('BOM_MAX_DEPTH_EXCEEDED');
    }

    visitedItems.add(finishedItemId);

    for (const comp of components.filter(
      (c: any) => c.isSubAssembly && c.subBomId,
    )) {
      const subBomIdStr = (comp as any).subBomId?.toString();
      if (!subBomIdStr) continue;

      const subBom = await this.bomModel
        .findOne({
          _id: new Types.ObjectId(subBomIdStr),
          isDeleted: false,
        })
        .lean();

      if (!subBom) continue;

      const subItemId = subBom.finishedItemId.toString();

      if (visitedItems.has(subItemId)) {
        throw new BadRequestException('CIRCULAR_BOM_REFERENCE');
      }

      await this.detectCircularRef(
        subItemId,
        subBom.components as unknown as BomComponent[],
        new Set(visitedItems),
        depth + 1,
      );
    }
  }
}
