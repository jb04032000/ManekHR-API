import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { WorkOrder, WorkOrderStep } from './schemas/work-order.schema';
import { CreateWorkOrderDto } from './dto/create-work-order.dto';
import { UpdateWorkOrderDto } from './dto/update-work-order.dto';
import { CreateWorkOrderStepDto } from './dto/create-work-order-step.dto';
import { UpdateWorkOrderStepDto } from './dto/update-work-order-step.dto';
import { CreateStepEntryDto } from './dto/create-step-entry.dto';
import { ListWorkOrdersQueryDto } from './dto/list-work-orders.query.dto';
import { WorkspaceCounterService } from '../workspaces/workspace-counter.service';

interface WorkOrderContext {
  workspaceId: string;
  userId: string;
}

/**
 * WorkOrdersService — work-order + embedded step/entry CRUD for the web
 * Shop Floor Control page (app/dashboard/machines/shop-floor).
 *
 * Responsibilities:
 *   - Counter-driven WO-NNN codes (reuses WorkspaceCounter, mirrors DT-NNN).
 *   - DAG integrity: dep existence + DFS cycle rejection (WORK_ORDER_STEP_CYCLE)
 *     on every write that touches `deps`; dep ids stripped on step delete.
 *   - Cross-workspace guards: machineIds / assigneeId must belong to the
 *     same workspace (mirrors ProductionLogsService machine validation).
 *   - PERT coercion: likely = max(likely, optimistic); pess = max(pess, likely)
 *     — coerce, never 400 (matches the HTML prototype behaviour).
 *   - Every mutation returns the FULL updated WorkOrder (plain object, raw
 *     `_id`s like downtime's lean reads) so the client replaces it atomically.
 *   - Mongoose 8.23 autocast workaround at every filter site
 *     (memory: project_attendance_module_session_2026-04-22.md).
 */
@Injectable()
export class WorkOrdersService {
  private readonly logger = new Logger(WorkOrdersService.name);

  constructor(
    @InjectModel(WorkOrder.name)
    private readonly workOrderModel: Model<WorkOrder>,
    // String tokens — avoid SWC decorator-metadata trip on Mongoose autocast
    // resolver; resolve identically at build time (STATE.md F-16-02).
    @InjectModel('Machine')
    private readonly machineModel: Model<any>,
    @InjectModel('TeamMember')
    private readonly teamMemberModel: Model<any>,
    @InjectModel('User')
    private readonly userModel: Model<any>,
    private readonly counterService: WorkspaceCounterService,
  ) {}

  // ============================================================
  // PUBLIC API — ORDERS
  // ============================================================

  /**
   * List non-deleted work orders for the workspace (steps included),
   * newest first. Optional `?status=` narrows to one lifecycle state.
   */
  async list(ctx: WorkOrderContext, query: ListWorkOrdersQueryDto): Promise<WorkOrder[]> {
    const filter: any = {
      workspaceId: new Types.ObjectId(ctx.workspaceId),
      isDeleted: false,
    };
    if (query.status) {
      filter.status = query.status;
    }
    return this.workOrderModel
      .find(filter)
      .sort({ createdAt: -1 })
      .lean()
      .exec() as unknown as Promise<WorkOrder[]>;
  }

  /**
   * Create a work order with an empty step list. Reserves the next WO-NNN
   * code atomically via WorkspaceCounter (mirrors downtime's DT-NNN flow).
   */
  async create(ctx: WorkOrderContext, dto: CreateWorkOrderDto): Promise<WorkOrder> {
    const seq = await this.counterService.reserveNextWorkOrderCode(ctx.workspaceId);
    const code = this.formatWorkOrderCode(seq);

    const created = await this.workOrderModel.create({
      workspaceId: new Types.ObjectId(ctx.workspaceId),
      code,
      partyName: dto.partyName,
      productType: dto.productType,
      qty: dto.qty,
      ratePerUnit: dto.ratePerUnit,
      colorHex: dto.colorHex ?? '#F0A030',
      status: 'active',
      steps: [],
      createdBy: new Types.ObjectId(ctx.userId),
      isDeleted: false,
    });

    this.logger.log(`WorkOrdersService: created ${code} in workspace ${ctx.workspaceId}`);
    return created.toObject() as WorkOrder;
  }

  /**
   * Update order-level fields (partyName, qty, rate, colour, status, ...).
   */
  async update(
    ctx: WorkOrderContext,
    orderId: string,
    dto: UpdateWorkOrderDto,
  ): Promise<WorkOrder> {
    const order = await this.findOrderOrThrow(ctx, orderId);

    if (dto.partyName !== undefined) order.partyName = dto.partyName;
    if (dto.productType !== undefined) order.productType = dto.productType;
    if (dto.qty !== undefined) order.qty = dto.qty;
    if (dto.ratePerUnit !== undefined) order.ratePerUnit = dto.ratePerUnit;
    if (dto.colorHex !== undefined) order.colorHex = dto.colorHex;
    if (dto.status !== undefined) order.status = dto.status;

    await order.save();
    return order.toObject() as WorkOrder;
  }

  /**
   * Soft-delete an order. Returns the full doc (isDeleted: true) so the
   * client can drop it from state. Frees the WO code via the partial index.
   */
  async softDelete(ctx: WorkOrderContext, orderId: string): Promise<WorkOrder> {
    const order = await this.findOrderOrThrow(ctx, orderId);
    order.isDeleted = true;
    order.deletedAt = new Date();
    await order.save();

    this.logger.log(
      `WorkOrdersService: soft-deleted ${order.code} in workspace ${ctx.workspaceId}`,
    );
    return order.toObject() as WorkOrder;
  }

  // ============================================================
  // PUBLIC API — STEPS
  // ============================================================

  /**
   * Add a step. A new node has no dependents, so it cannot close a cycle —
   * only dep EXISTENCE is checked here (plus cross-workspace machine/member
   * guards and PERT coercion).
   */
  async addStep(
    ctx: WorkOrderContext,
    orderId: string,
    dto: CreateWorkOrderStepDto,
  ): Promise<WorkOrder> {
    const order = await this.findOrderOrThrow(ctx, orderId);

    const deps = dto.deps ?? [];
    this.assertDepsExist(order.steps, deps);
    await this.assertMachinesInWorkspace(ctx.workspaceId, dto.machineIds ?? []);
    await this.assertMemberInWorkspace(ctx.workspaceId, dto.assigneeId);

    const { optimisticHrs, likelyHrs, pessimisticHrs } = this.coercePert(
      dto.optimisticHrs,
      dto.likelyHrs,
      dto.pessimisticHrs,
    );

    order.steps.push({
      name: dto.name,
      stage: dto.stage,
      machineIds: (dto.machineIds ?? []).map((id) => new Types.ObjectId(id)),
      assigneeId: dto.assigneeId ? new Types.ObjectId(dto.assigneeId) : null,
      deps,
      optimisticHrs,
      likelyHrs,
      pessimisticHrs,
      wageRate: dto.wageRate ?? 0,
      progress: dto.progress ?? 0,
      posX: dto.posX ?? null,
      posY: dto.posY ?? null,
      entries: [],
    } as WorkOrderStep);

    await order.save();
    return order.toObject() as WorkOrder;
  }

  /**
   * Update a step. When `deps` changes, dep existence (self-ref excluded)
   * is re-validated AND a full-graph DFS rejects cycles with
   * 400 WORK_ORDER_STEP_CYCLE. PERT trio is re-coerced over merged values.
   */
  async updateStep(
    ctx: WorkOrderContext,
    orderId: string,
    stepId: string,
    dto: UpdateWorkOrderStepDto,
  ): Promise<WorkOrder> {
    const order = await this.findOrderOrThrow(ctx, orderId);
    const step = this.findStepOrThrow(order, stepId);

    if (dto.deps !== undefined) {
      const otherSteps = order.steps.filter((s) => s._id.toString() !== stepId);
      this.assertDepsExist(otherSteps, dto.deps, stepId);
      // Cycle check over the WHOLE graph with the proposed deps in place.
      const graph = order.steps.map((s) => ({
        id: s._id.toString(),
        deps: s._id.toString() === stepId ? dto.deps : s.deps,
      }));
      if (this.hasCycle(graph)) {
        throw new BadRequestException({
          code: 'WORK_ORDER_STEP_CYCLE',
          message: 'Step dependencies would create a cycle.',
        });
      }
      step.deps = dto.deps;
    }

    if (dto.machineIds !== undefined) {
      await this.assertMachinesInWorkspace(ctx.workspaceId, dto.machineIds);
      step.machineIds = dto.machineIds.map((id) => new Types.ObjectId(id));
    }
    if (dto.assigneeId !== undefined) {
      await this.assertMemberInWorkspace(ctx.workspaceId, dto.assigneeId);
      step.assigneeId = dto.assigneeId ? new Types.ObjectId(dto.assigneeId) : null;
    }

    if (dto.name !== undefined) step.name = dto.name;
    if (dto.stage !== undefined) step.stage = dto.stage;
    if (dto.wageRate !== undefined) step.wageRate = dto.wageRate;
    if (dto.progress !== undefined) step.progress = dto.progress;
    if (dto.posX !== undefined) step.posX = dto.posX;
    if (dto.posY !== undefined) step.posY = dto.posY;

    if (
      dto.optimisticHrs !== undefined ||
      dto.likelyHrs !== undefined ||
      dto.pessimisticHrs !== undefined
    ) {
      const merged = this.coercePert(
        dto.optimisticHrs ?? step.optimisticHrs,
        dto.likelyHrs ?? step.likelyHrs,
        dto.pessimisticHrs ?? step.pessimisticHrs,
      );
      step.optimisticHrs = merged.optimisticHrs;
      step.likelyHrs = merged.likelyHrs;
      step.pessimisticHrs = merged.pessimisticHrs;
    }

    await order.save();
    return order.toObject() as WorkOrder;
  }

  /**
   * Remove a step AND strip its _id from every other step's `deps` so the
   * Shop Floor canvas never renders dangling edges.
   */
  async removeStep(ctx: WorkOrderContext, orderId: string, stepId: string): Promise<WorkOrder> {
    const order = await this.findOrderOrThrow(ctx, orderId);
    this.findStepOrThrow(order, stepId);

    order.steps = order.steps.filter((s) => s._id.toString() !== stepId);
    for (const s of order.steps) {
      if (s.deps.includes(stepId)) {
        s.deps = s.deps.filter((d) => d !== stepId);
      }
    }

    await order.save();
    return order.toObject() as WorkOrder;
  }

  // ============================================================
  // PUBLIC API — STEP ENTRIES
  // ============================================================

  /**
   * Append a manual progress-log entry. `byUserId` comes from the JWT,
   * `byName` is a server-resolved display-name snapshot, `at` is server
   * time. Non-null `progress` overwrites step.progress.
   */
  async addEntry(
    ctx: WorkOrderContext,
    orderId: string,
    stepId: string,
    dto: CreateStepEntryDto,
  ): Promise<WorkOrder> {
    const order = await this.findOrderOrThrow(ctx, orderId);
    const step = this.findStepOrThrow(order, stepId);
    const byName = await this.resolveUserName(ctx.userId);

    step.entries.push({
      qty: dto.qty ?? null,
      progress: dto.progress ?? null,
      note: dto.note,
      byUserId: new Types.ObjectId(ctx.userId),
      byName,
      at: new Date(),
    });

    if (dto.progress !== undefined && dto.progress !== null) {
      step.progress = dto.progress;
    }

    await order.save();
    return order.toObject() as WorkOrder;
  }

  /**
   * Delete an entry, then recompute step.progress from the LATEST remaining
   * entry that carries a non-null progress (by `at`, then insertion order);
   * 0 when none remain.
   */
  async removeEntry(
    ctx: WorkOrderContext,
    orderId: string,
    stepId: string,
    entryId: string,
  ): Promise<WorkOrder> {
    const order = await this.findOrderOrThrow(ctx, orderId);
    const step = this.findStepOrThrow(order, stepId);

    const before = step.entries.length;
    step.entries = step.entries.filter((e) => e._id.toString() !== entryId);
    if (step.entries.length === before) {
      throw new NotFoundException({
        code: 'WORK_ORDER_ENTRY_NOT_FOUND',
        message: 'Step entry not found.',
      });
    }

    // Latest non-null-progress entry wins (stable: later index breaks ties).
    let recomputed = 0;
    let bestAt = -Infinity;
    for (const e of step.entries) {
      if (e.progress === null || e.progress === undefined) continue;
      const at = e.at ? new Date(e.at).getTime() : 0;
      if (at >= bestAt) {
        bestAt = at;
        recomputed = e.progress;
      }
    }
    step.progress = recomputed;

    await order.save();
    return order.toObject() as WorkOrder;
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  /**
   * Load a non-deleted order scoped to the workspace, or 404
   * WORK_ORDER_NOT_FOUND. Invalid ObjectId strings 404 too (no CastError 500s).
   */
  private async findOrderOrThrow(ctx: WorkOrderContext, orderId: string): Promise<WorkOrder> {
    if (!Types.ObjectId.isValid(orderId)) {
      throw new NotFoundException({
        code: 'WORK_ORDER_NOT_FOUND',
        message: 'Work order not found.',
      });
    }
    const order = await this.workOrderModel
      .findOne({
        _id: new Types.ObjectId(orderId),
        workspaceId: new Types.ObjectId(ctx.workspaceId),
        isDeleted: false,
      })
      .exec();
    if (!order) {
      throw new NotFoundException({
        code: 'WORK_ORDER_NOT_FOUND',
        message: 'Work order not found.',
      });
    }
    return order;
  }

  private findStepOrThrow(order: WorkOrder, stepId: string): WorkOrderStep {
    const step = order.steps.find((s) => s._id.toString() === stepId);
    if (!step) {
      throw new NotFoundException({
        code: 'WORK_ORDER_STEP_NOT_FOUND',
        message: 'Work order step not found.',
      });
    }
    return step;
  }

  /**
   * Every dep must reference an EXISTING sibling step; self-reference is a
   * trivial cycle and rejected with WORK_ORDER_STEP_CYCLE.
   */
  private assertDepsExist(steps: WorkOrderStep[], deps: string[], selfId?: string): void {
    if (selfId && deps.includes(selfId)) {
      throw new BadRequestException({
        code: 'WORK_ORDER_STEP_CYCLE',
        message: 'A step cannot depend on itself.',
      });
    }
    const known = new Set(steps.map((s) => s._id.toString()));
    const missing = deps.filter((d) => !known.has(d));
    if (missing.length > 0) {
      throw new BadRequestException({
        code: 'WORK_ORDER_STEP_DEP_NOT_FOUND',
        message: `Unknown dependency step id(s): ${missing.join(', ')}.`,
      });
    }
  }

  /**
   * Iterative 3-colour DFS over the deps graph. Returns true on a back edge
   * (cycle). Edges point step -> each id in step.deps.
   */
  private hasCycle(graph: { id: string; deps: string[] }[]): boolean {
    const adj = new Map(graph.map((n) => [n.id, n.deps]));
    // 0 = white (unvisited), 1 = grey (on stack), 2 = black (done)
    const color = new Map<string, number>();
    for (const node of graph) {
      if ((color.get(node.id) ?? 0) !== 0) continue;
      const stack: { id: string; nextIdx: number }[] = [{ id: node.id, nextIdx: 0 }];
      color.set(node.id, 1);
      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        const deps = adj.get(frame.id) ?? [];
        if (frame.nextIdx < deps.length) {
          const next = deps[frame.nextIdx++];
          const c = color.get(next) ?? 0;
          if (c === 1) return true; // back edge — cycle
          if (c === 0 && adj.has(next)) {
            color.set(next, 1);
            stack.push({ id: next, nextIdx: 0 });
          }
        } else {
          color.set(frame.id, 2);
          stack.pop();
        }
      }
    }
    return false;
  }

  /**
   * PERT ordering coercion (matches the HTML prototype — never 400s):
   * likely = max(likely, optimistic); pessimistic = max(pessimistic, likely).
   */
  private coercePert(
    optimisticHrs: number,
    likelyHrs: number,
    pessimisticHrs: number,
  ): { optimisticHrs: number; likelyHrs: number; pessimisticHrs: number } {
    const likely = Math.max(likelyHrs, optimisticHrs);
    const pessimistic = Math.max(pessimisticHrs, likely);
    return { optimisticHrs, likelyHrs: likely, pessimisticHrs: pessimistic };
  }

  /**
   * All machineIds must exist, be non-deleted, and belong to this workspace —
   * 404 MACHINE_NOT_FOUND otherwise (mirrors ProductionLogsService).
   */
  private async assertMachinesInWorkspace(
    workspaceId: string,
    machineIds: string[],
  ): Promise<void> {
    if (machineIds.length === 0) return;
    const unique = [...new Set(machineIds)];
    const count = await this.machineModel
      .countDocuments({
        _id: { $in: unique.map((id) => new Types.ObjectId(id)) },
        workspaceId: new Types.ObjectId(workspaceId),
        isDeleted: false,
      })
      .exec();
    if (count !== unique.length) {
      throw new NotFoundException({
        code: 'MACHINE_NOT_FOUND',
        message: 'Machine not found or not in this workspace.',
      });
    }
  }

  /**
   * assigneeId (when provided) must be a non-deleted team member of this
   * workspace — 404 TEAM_MEMBER_NOT_FOUND otherwise.
   */
  private async assertMemberInWorkspace(
    workspaceId: string,
    assigneeId?: string | null,
  ): Promise<void> {
    if (!assigneeId) return;
    const member = await this.teamMemberModel
      .findOne({
        _id: new Types.ObjectId(assigneeId),
        workspaceId: new Types.ObjectId(workspaceId),
        isDeleted: false,
      })
      .select('_id')
      .lean()
      .exec();
    if (!member) {
      throw new NotFoundException({
        code: 'TEAM_MEMBER_NOT_FOUND',
        message: 'Team member not found or not in this workspace.',
      });
    }
  }

  /**
   * Resolve the acting user's display name for the `byName` snapshot
   * (mirrors AuditService.resolveActorName). Falls back to email, then
   * 'User' — never throws; a missing User doc must not block the write.
   */
  private async resolveUserName(userId: string): Promise<string> {
    if (!Types.ObjectId.isValid(userId)) return 'User';
    const user = await this.userModel
      .findById(new Types.ObjectId(userId))
      .select('name email')
      .lean<{ name?: string; email?: string }>()
      .exec();
    return user?.name?.trim() || user?.email?.trim() || 'User';
  }

  /**
   * Format a sequence number into the canonical WO-NNN code (mirrors DT-NNN).
   */
  private formatWorkOrderCode(seq: number): string {
    return `WO-${String(seq).padStart(3, '0')}`;
  }
}
