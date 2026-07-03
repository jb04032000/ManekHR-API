import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Production stages a work-order step can belong to. Drives the stage picker
 * on the web Shop Floor page (app/dashboard/machines/shop-floor) — keep in
 * sync with the web-side STAGES constant.
 */
export const WORK_ORDER_STAGES = [
  'inward',
  'design',
  'marking',
  'embroidery',
  'handwork',
  'cutting',
  'washing',
  'sewing',
  'finishing',
  'qc',
  'packing',
  'dispatch',
] as const;
export type WorkOrderStage = (typeof WORK_ORDER_STAGES)[number];

export const WORK_ORDER_STATUSES = ['active', 'completed', 'archived'] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

/**
 * StepEntry — manual progress-log line embedded inside a step.
 * `at`, `byUserId` and `byName` are server-set (never client-supplied). An
 * entry with non-null `progress` overwrites step.progress; deleting an entry
 * recomputes step.progress from the latest remaining non-null-progress entry.
 *
 * All `@Prop` decorators use explicit `{ type: ... }` to dodge the Mongoose
 * 8.23 autocast bug (memory: project_attendance_module_session_2026-04-22.md).
 */
@Schema({ _id: true })
export class StepEntry {
  _id?: Types.ObjectId;

  @Prop({ type: Number, default: null, min: 0 })
  qty: number | null;

  @Prop({ type: Number, default: null, min: 0, max: 100 })
  progress: number | null;

  @Prop({ type: String, trim: true, maxlength: 500 })
  note?: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  byUserId: Types.ObjectId;

  // Display-name snapshot of the acting user at write time (mirrors audit's
  // actorNameSnapshot) — survives later renames/deletes of the User doc.
  @Prop({ type: String, required: true, trim: true, maxlength: 160 })
  byName: string;

  @Prop({ type: Date, required: true })
  at: Date;
}

export const StepEntrySchema = SchemaFactory.createForClass(StepEntry);

/**
 * WorkOrderStep — embedded DAG node with CPM/PERT three-point estimates.
 * `deps` holds _id STRINGS of sibling steps in the SAME work order; the
 * service validates dep existence + rejects cycles (WORK_ORDER_STEP_CYCLE)
 * on every write that touches deps. posX/posY persist the Shop Floor canvas
 * layout — purely presentational, no server meaning.
 */
@Schema({ _id: true })
export class WorkOrderStep {
  _id?: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 160 })
  name: string;

  @Prop({ type: String, enum: WORK_ORDER_STAGES, required: true })
  stage: WorkOrderStage;

  // Machines this step runs on — validated same-workspace on write.
  @Prop({ type: [Types.ObjectId], ref: 'Machine', default: [] })
  machineIds: Types.ObjectId[];

  // Team member doing the work — validated same-workspace on write.
  @Prop({ type: Types.ObjectId, ref: 'TeamMember', default: null })
  assigneeId: Types.ObjectId | null;

  // _id strings of OTHER steps in this work order (DAG edges, "depends on").
  @Prop({ type: [String], default: [] })
  deps: string[];

  // PERT three-point estimates (hours). Service coerces the ordering
  // optimistic <= likely <= pessimistic (mirrors the HTML prototype).
  @Prop({ type: Number, required: true, min: 0 })
  optimisticHrs: number;

  @Prop({ type: Number, required: true, min: 0 })
  likelyHrs: number;

  @Prop({ type: Number, required: true, min: 0 })
  pessimisticHrs: number;

  // ₹ per piece for this step's karigar wage maths on the web side.
  @Prop({ type: Number, required: true, default: 0, min: 0 })
  wageRate: number;

  // 0..100 — manually driven via entries (latest non-null entry.progress wins).
  @Prop({ type: Number, required: true, default: 0, min: 0, max: 100 })
  progress: number;

  // Shop Floor canvas coordinates (optional; null until first drag).
  @Prop({ type: Number, default: null })
  posX: number | null;

  @Prop({ type: Number, default: null })
  posY: number | null;

  @Prop({ type: [StepEntrySchema], default: [] })
  entries: StepEntry[];
}

export const WorkOrderStepSchema = SchemaFactory.createForClass(WorkOrderStep);

/**
 * WorkOrder — single source of truth for the web Shop Floor Control page
 * (app/dashboard/machines/shop-floor). One doc per production order; steps
 * are embedded (whole-doc replace on the client after every mutation).
 *
 * `code` is 'WO-NNN' reserved from WorkspaceCounter.workOrderCounter at
 * create — unique per workspace among non-deleted docs (partial index below).
 */
@Schema({ timestamps: true, collection: 'workorders' })
export class WorkOrder extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 32 })
  code: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 160 })
  partyName: string;

  @Prop({ type: String, trim: true, maxlength: 160 })
  productType?: string;

  @Prop({ type: Number, required: true, min: 1 })
  qty: number;

  @Prop({ type: Number, required: true, min: 0 })
  ratePerUnit: number;

  // Chip / lane colour on the Shop Floor canvas.
  @Prop({
    type: String,
    required: true,
    default: '#F0A030',
    match: /^#[0-9a-fA-F]{6}$/,
  })
  colorHex: string;

  @Prop({
    type: String,
    enum: WORK_ORDER_STATUSES,
    required: true,
    default: 'active',
  })
  status: WorkOrderStatus;

  @Prop({ type: [WorkOrderStepSchema], default: [] })
  steps: WorkOrderStep[];

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;

  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const WorkOrderSchema = SchemaFactory.createForClass(WorkOrder);

// Per-workspace partial-unique on code — non-deleted only (mirrors downtime).
WorkOrderSchema.index(
  { workspaceId: 1, code: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);

// Primary read path — Shop Floor list per workspace, newest first.
WorkOrderSchema.index({ workspaceId: 1, status: 1, isDeleted: 1, createdAt: -1 });
