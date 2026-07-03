import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  REASON_CATEGORIES,
  ReasonCategory,
} from './downtime-reason-config.schema';

// Re-export so consumers can import REASON_CATEGORIES / ReasonCategory from
// either schema file without caring about which one owns the canonical const.
// (Plan 22-03 already defined them in downtime-reason-config.schema.ts;
// this re-export keeps the plan's acceptance grep happy and gives downstream
// modules a single import surface from the entry schema.)
export { REASON_CATEGORIES, ReasonCategory };

/**
 * DowntimeEntry — workspace-scoped, machine-scoped record of a downtime
 * interval (D-01). Standalone collection mirroring the ProductionLog pattern.
 *
 * Status invariants (D-04, D-05):
 *   - `endAt: null` ⇒ open / active downtime.
 *   - At most ONE open entry per (workspaceId, machineId) — enforced by the
 *     partial-unique index on (workspaceId, machineId, endAt) below; this is
 *     the DB-layer backstop for the service-level overlap guard.
 *
 * Snapshot fields (`reasonCodeSnapshot`, `reasonLabelSnapshot`,
 * `reasonCategory`) preserve historical display + status mapping even when
 * the workspace catalogue is later renamed / re-categorised / disabled.
 *
 * All `@Prop` decorators use explicit `{ type: ... }` to dodge the Mongoose
 * 8.23 autocast bug (D-15;
 * memory: project_attendance_module_session_2026-04-22.md).
 */
@Schema({ timestamps: true, collection: 'downtime_entries' })
export class DowntimeEntry extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Machine', required: true, index: true })
  machineId: Types.ObjectId;

  // FK to WorkspaceDowntimeReasonConfig.codes[]._id (subdoc id) — used for
  // live label resolution. Snapshot fields below preserve historical display.
  @Prop({ type: Types.ObjectId, required: true })
  reasonCodeId: Types.ObjectId;

  // Snapshot of the immutable reason key (e.g. 'breakdown') — survives
  // reason rename/delete.
  @Prop({ type: String, required: true, trim: true, maxlength: 60 })
  reasonCodeSnapshot: string;

  // Display label at log time — preserved across owner relabel of catalogue.
  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  reasonLabelSnapshot: string;

  // Drives machine.status mapping in MachinesService.recomputeStatus (D-03).
  @Prop({ type: String, enum: REASON_CATEGORIES, required: true })
  reasonCategory: ReasonCategory;

  @Prop({ type: Date, required: true, index: true })
  startAt: Date;

  // null = open/active downtime. Partial unique index enforces ≤1 open
  // per machine (D-05 DB backstop).
  @Prop({ type: Date, default: null })
  endAt: Date | null;

  // Computed at close: ceil((endAt - startAt) / 60_000). Null while open.
  @Prop({ type: Number, default: null, min: 0 })
  durationMinutes: number | null;

  @Prop({ type: String, trim: true, maxlength: 500 })
  notes?: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  loggedByUserId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  closedByUserId: Types.ObjectId | null;

  // 'DT-001' reserved at create time from WorkspaceCounter.downtimeCounter
  // (D-12).
  @Prop({ type: String, required: true, trim: true, maxlength: 32 })
  downtimeCode: string;

  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const DowntimeEntrySchema = SchemaFactory.createForClass(DowntimeEntry);

// (1) Per-workspace partial-unique on downtimeCode — non-deleted only.
DowntimeEntrySchema.index(
  { workspaceId: 1, downtimeCode: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);

// (2) Primary read path — list per machine ordered by startAt desc.
DowntimeEntrySchema.index({
  workspaceId: 1,
  machineId: 1,
  startAt: -1,
  isDeleted: 1,
});

// (3) Open-downtime partial unique — at most one endAt:null per machine.
//     THIS IS THE D-05 DB BACKSTOP (MACH-P2-02b). DO NOT change the filter.
DowntimeEntrySchema.index(
  { workspaceId: 1, machineId: 1, endAt: 1 },
  { unique: true, partialFilterExpression: { endAt: null, isDeleted: false } },
);

// (4) Overlap range query support — covers $or branches in assertNoOverlap.
DowntimeEntrySchema.index({
  workspaceId: 1,
  machineId: 1,
  startAt: 1,
  endAt: 1,
  isDeleted: 1,
});

// (5) Phase 25 dashboard prep — workspace-wide reads by date.
DowntimeEntrySchema.index({ workspaceId: 1, startAt: -1, isDeleted: 1 });
