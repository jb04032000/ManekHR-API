import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Cadence modes for preventive-maintenance scheduling (MACH-P2-04).
 * Five values verbatim — DO NOT add/remove without updating the requirement
 * + computeNextDue() switch in MaintenanceSchedulesService (Plan 24-04).
 */
export const CADENCE_MODES = [
  'daily',
  'weekly',
  'monthly',
  'hours_based',
  'output_based',
] as const;
export type CadenceMode = (typeof CADENCE_MODES)[number];

/**
 * MaintenanceSchedule — workspace + machine-scoped recurring service plan
 * (D-01, Phase 24). Multiple schedules per machine are permitted (e.g.
 * "Daily oil top-up" + "Monthly belt inspection").
 *
 * Counter-minted `scheduleCode` (`MS-001`) is reserved by
 * WorkspaceCounterService.reserveNextMaintenanceScheduleCode (Plan 24-01)
 * and set by the service layer on insert.
 *
 * `nextDueAt` is computed from {anchorDate | lastServicedAt} +
 * {cadenceMode, cadenceInterval} via MaintenanceSchedulesService.computeNextDue
 * (Plan 24-04, D-03). For `hours_based` / `output_based` it is set to "now"
 * once the accumulated counter crosses the interval, else far-future.
 *
 * `hoursAccumulated` / `outputAccumulated` are best-effort caches refreshed by
 * the daily 02:00 cron (D-03). The alert-query path may also derive them
 * on-demand from DowntimeEntry / ProductionLog.
 *
 * All `@Prop` decorators carry an explicit `{ type: ... }` to dodge the
 * Mongoose 8.23 autocast bug (MACH-P2-XC-06;
 * memory: project_attendance_module_session_2026-04-22.md).
 */
@Schema({ timestamps: true, collection: 'maintenance_schedules' })
export class MaintenanceSchedule extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Machine', required: true, index: true })
  machineId: Types.ObjectId;

  // 'MS-001' — reserved via WorkspaceCounter at create time (Plan 24-01).
  @Prop({ type: String, required: true, trim: true, maxlength: 32 })
  scheduleCode: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 80 })
  name: string;

  @Prop({ type: String, enum: CADENCE_MODES, required: true })
  cadenceMode: CadenceMode;

  // Interpretation depends on cadenceMode (days / weeks / months / hours /
  // primary-metric units). Always >= 1.
  @Prop({ type: Number, required: true, min: 1 })
  cadenceInterval: number;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', default: null })
  technicianId: Types.ObjectId | null;

  // Embedded — capped at 50 entries (D-01). Per-item length cap (200 chars)
  // enforced at DTO layer.
  @Prop({
    type: [String],
    default: [],
    validate: (v: string[]) => v.length <= 50,
  })
  checklistItems: string[];

  // Per-schedule override of workspace.maintenanceLeadTimeDays (default 7).
  // Resolution: schedule.leadTimeDays ?? workspace.maintenanceLeadTimeDays ?? 7.
  @Prop({ type: Number, min: 1, max: 30, default: null })
  leadTimeDays: number | null;

  // Default service-window length for the auto-created DowntimeEntry (D-05).
  // Default 60 min; max 1440 (24h).
  @Prop({ type: Number, min: 1, max: 24 * 60, default: 60 })
  estimatedDurationMinutes: number;

  // Override the seed 'maintenance' downtime reason if owner customised
  // their workspace catalogue. Resolved by ServiceLogsService at create.
  @Prop({ type: Types.ObjectId, default: null })
  defaultDowntimeReasonCodeId: Types.ObjectId | null;

  // Start of cadence reckoning. Defaults to createdAt at the service layer.
  @Prop({ type: Date, required: true })
  anchorDate: Date;

  // Computed; recomputed on every ServiceLog complete + daily cron (D-03).
  @Prop({ type: Date, required: true, index: true })
  nextDueAt: Date;

  // Best-effort cache for hours_based cadence. Source-of-truth derivable from
  // DowntimeEntry duration since lastServicedAt (D-03 v1 approximation).
  @Prop({ type: Number, default: 0, min: 0 })
  hoursAccumulated: number;

  // Best-effort cache for output_based cadence. Source-of-truth = sum of
  // ProductionLog primary metric since lastServicedAt (D-03).
  @Prop({ type: Number, default: 0, min: 0 })
  outputAccumulated: number;

  // Anchor for next-due re-compute; null if never serviced.
  @Prop({ type: Date, default: null })
  lastServicedAt: Date | null;

  // Pause without delete — owner can temporarily silence alerts.
  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  updatedBy: Types.ObjectId;
}

export const MaintenanceScheduleSchema =
  SchemaFactory.createForClass(MaintenanceSchedule);

// (1) Primary read path — list schedules per machine (active + non-deleted
//     filter applied at query time).
MaintenanceScheduleSchema.index({
  workspaceId: 1,
  machineId: 1,
  isActive: 1,
  isDeleted: 1,
});

// (2) Alert-query path (D-04) — workspace-wide due lookup, partial-filtered
//     to live schedules to keep the index small + selective.
MaintenanceScheduleSchema.index(
  { workspaceId: 1, nextDueAt: 1 },
  { partialFilterExpression: { isActive: true, isDeleted: false } },
);

// (3) Per-workspace partial-unique on scheduleCode — non-deleted only so a
//     soft-deleted schedule does not block re-issuing the same code (which
//     should not happen, but defends against counter races).
MaintenanceScheduleSchema.index(
  { workspaceId: 1, scheduleCode: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);
