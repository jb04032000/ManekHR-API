import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ServicePart — embedded sub-document on ServiceLog.partsReplaced (D-02).
 *
 * Two ways to specify a part — exactly ONE of `{ itemId, freeTextName }` MUST
 * be set. The XOR is enforced at the schema layer via the `pre('validate')`
 * hook below (surfaces `SERVICE_PART_REQUIRES_ITEM_OR_TEXT` to the caller),
 * mirrored at the DTO layer for fast-fail UX (24-03 Plan, key_links).
 *
 * `itemNameSnapshot` captures `Item.name` at create time so the historical
 * row survives parent rename / delete (snapshot pattern from Phase 22 D-01).
 *
 * All `@Prop` decorators carry an explicit `{ type: ... }` — Mongoose 8.23
 * autocast bug guard (MACH-P2-XC-06).
 */
@Schema({ _id: false })
export class ServicePart {
  @Prop({ type: Types.ObjectId, ref: 'Item', default: null })
  itemId: Types.ObjectId | null;

  @Prop({ type: String, trim: true, maxlength: 120, default: null })
  freeTextName: string | null;

  // Captured from Item.name on create — survives rename/delete of the parent
  // Item (Phase 22 D-01 snapshot pattern).
  @Prop({ type: String, trim: true, maxlength: 120, default: null })
  itemNameSnapshot: string | null;

  @Prop({ type: Number, required: true, min: 0 })
  quantity: number;

  @Prop({ type: Number, default: null, min: 0 })
  unitCostPaise: number | null;

  @Prop({ type: String, trim: true, maxlength: 200 })
  notes?: string;
}
export const ServicePartSchema = SchemaFactory.createForClass(ServicePart);

// XOR enforcement at the schema layer — exactly one of {itemId, freeTextName}
// MUST be set. Surfaces `SERVICE_PART_REQUIRES_ITEM_OR_TEXT` to the caller;
// ServiceLogsService (24-06) catches this and re-throws as 400.
ServicePartSchema.pre('validate', function (next) {
  const hasItem = !!(this as any).itemId;
  const hasText = !!(this as any).freeTextName?.toString().trim();
  if (hasItem === hasText) {
    return next(new Error('SERVICE_PART_REQUIRES_ITEM_OR_TEXT'));
  }
  next();
});

/**
 * ChecklistTick — snapshot of a single checklist row at the time of service
 * (D-02). Captured from `MaintenanceSchedule.checklistItems` on ServiceLog
 * create so subsequent edits to the schedule don't rewrite history.
 */
@Schema({ _id: false })
export class ChecklistTick {
  @Prop({ type: String, required: true, maxlength: 200 })
  item: string;

  @Prop({ type: Boolean, required: true })
  ticked: boolean;
}
export const ChecklistTickSchema = SchemaFactory.createForClass(ChecklistTick);

/**
 * ServiceLog — workspace + machine-scoped permanent record of completed
 * preventive-maintenance work (D-02, MACH-P2-04b).
 *
 * **History is permanent — there is NO soft-delete field** (D-15). The DELETE
 * endpoint is intentionally not exposed. `notes` and `costPaise` are editable
 * within a 7-day window (enforced at service layer in 24-06); all other
 * fields are FROZEN immediately on create (`SERVICE_LOG_FROZEN_FIELD` 400 if
 * attempted via UpdateServiceLogDto rejection at the validator layer).
 *
 * `serviceLogCode` (`MAINT-001`) is reserved by
 * WorkspaceCounterService.reserveNextServiceLogCode (Plan 24-01) and stamped
 * by the service layer on insert.
 *
 * `linkedDowntimeId` is back-filled by ServiceLogsService.create after the
 * auto-created DowntimeEntry (Phase 22, D-05) is persisted.
 *
 * All `@Prop` decorators use explicit `{ type: ... }` (MACH-P2-XC-06).
 */
@Schema({ timestamps: true, collection: 'service_logs' })
export class ServiceLog extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Machine', required: true, index: true })
  machineId: Types.ObjectId;

  // null = ad-hoc service (no schedule wired).
  @Prop({ type: Types.ObjectId, ref: 'MaintenanceSchedule', default: null })
  scheduleId: Types.ObjectId | null;

  // 'MAINT-001' — reserved via WorkspaceCounter at create time (Plan 24-01).
  @Prop({ type: String, required: true, trim: true, maxlength: 32 })
  serviceLogCode: string;

  @Prop({ type: Date, required: true, index: true })
  servicedAt: Date;

  @Prop({ type: Date, required: true })
  serviceEndAt: Date;

  // Computed = ceil((serviceEndAt - servicedAt) / 60_000) by service layer.
  @Prop({ type: Number, required: true, min: 1 })
  durationMinutes: number;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', default: null })
  technicianId: Types.ObjectId | null;

  // Snapshot of TeamMember.name at create — survives rename/offboard.
  @Prop({ type: String, trim: true, maxlength: 120 })
  technicianNameSnapshot?: string;

  // Embedded — capped at 30 entries (DoS guard, mirrors Phase 22 D-02 cap).
  // XOR per-row enforcement lives on ServicePartSchema.pre('validate').
  @Prop({
    type: [ServicePartSchema],
    default: [],
    validate: (v: any[]) => v.length <= 30,
  })
  partsReplaced: ServicePart[];

  @Prop({ type: Number, default: 0, min: 0 })
  costPaise: number;

  @Prop({ type: String, trim: true, maxlength: 2000 })
  notes?: string;

  // Snapshot of MaintenanceSchedule.checklistItems at create — historical
  // tick state preserved across schedule edits.
  @Prop({ type: [ChecklistTickSchema], default: [] })
  checklistTicked: ChecklistTick[];

  // Back-filled by ServiceLogsService.create after auto-creating the
  // DowntimeEntry (Phase 22 D-05). null until the linked entry exists.
  @Prop({
    type: Types.ObjectId,
    ref: 'DowntimeEntry',
    default: null,
    index: true,
  })
  linkedDowntimeId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  loggedByUserId: Types.ObjectId;

  // NB: NO soft-delete field — D-02 + D-15 mandate permanent history.
}

export const ServiceLogSchema = SchemaFactory.createForClass(ServiceLog);

// (1) Per-machine history — primary read path for the maintenance tab.
ServiceLogSchema.index({ workspaceId: 1, machineId: 1, servicedAt: -1 });

// (2) Per-schedule history — drives "history for this schedule" view.
ServiceLogSchema.index({ workspaceId: 1, scheduleId: 1, servicedAt: -1 });

// (3) Per-technician history — Phase 25 "technician productivity" dashboard.
ServiceLogSchema.index({ workspaceId: 1, technicianId: 1, servicedAt: -1 });

// (4) Per-workspace partial-unique on serviceLogCode — no soft-delete on
//     ServiceLog (D-02), so an unconditional unique would also be safe; the
//     partial filter is harmless and consistent with the schedule-code
//     pattern in the sibling MaintenanceSchedule schema.
ServiceLogSchema.index(
  { workspaceId: 1, serviceLogCode: 1 },
  { unique: true },
);
