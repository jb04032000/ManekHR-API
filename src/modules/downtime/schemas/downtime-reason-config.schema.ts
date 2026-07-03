import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Reason categories — drives machine.status auto-mapping (D-03):
 *   'mechanical'  → machine.status = 'maintenance'
 *   'operational' → machine.status = 'idle'
 *
 * Defined here so it can be imported by both `downtime-reason-config.schema.ts`
 * and the upcoming `downtime-entry.schema.ts` (Plan 22-04).
 */
export const REASON_CATEGORIES = ['mechanical', 'operational'] as const;
export type ReasonCategory = (typeof REASON_CATEGORIES)[number];

/**
 * Embedded reason-code subdocument (D-02).
 *
 * - `key` is the stable kebab slug, IMMUTABLE after create.
 * - `label` is the display string, owner-editable.
 * - `category` drives machine.status mapping; locked for system codes.
 * - `isSystem` marks the 7 seed codes — they cannot be removed (only disabled).
 * - `isDisabled` hides the code from the new-entry picker but preserves
 *   historical entry resolution (snapshots survive).
 *
 * All `@Prop` decorators use explicit `{ type: ... }` to avoid the Mongoose
 * 8.23 autocast bug (project memory: project_attendance_module_session_2026-04-22.md).
 */
@Schema({ _id: true })
export class ReasonCode {
  _id?: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    maxlength: 60,
    match: /^[a-z][a-z0-9-]*$/,
  })
  key: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  label: string;

  @Prop({ type: String, enum: REASON_CATEGORIES, required: true })
  category: ReasonCategory;

  @Prop({ type: Boolean, required: true, default: false })
  isSystem: boolean;

  @Prop({ type: Boolean, required: true, default: false })
  isDisabled: boolean;

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  sortOrder: number;
}

export const ReasonCodeSchema = SchemaFactory.createForClass(ReasonCode);

/**
 * Per-workspace reason catalogue (D-02). One doc per workspace, lazy-created
 * on first read by `DowntimeReasonsService.get(wsId)`.
 */
@Schema({ timestamps: true, collection: 'workspace_downtime_reason_configs' })
export class WorkspaceDowntimeReasonConfig extends Document {
  @Prop({
    type: Types.ObjectId,
    ref: 'Workspace',
    required: true,
    unique: true,
    index: true,
  })
  workspaceId: Types.ObjectId;

  @Prop({ type: [ReasonCodeSchema], default: [] })
  codes: ReasonCode[];
}

export const WorkspaceDowntimeReasonConfigSchema = SchemaFactory.createForClass(
  WorkspaceDowntimeReasonConfig,
);

/**
 * The 7 system reason codes (MACH-P2-02). Inserted by lazy-seed on first read.
 *
 * Order + sortOrder match the D-02 table exactly:
 *   breakdown / maintenance / setup / changeover / quality-rejection /
 *   power-cut / no-order
 */
export const SYSTEM_REASON_CODES: Omit<ReasonCode, '_id'>[] = [
  {
    key: 'breakdown',
    label: 'Breakdown',
    category: 'mechanical',
    isSystem: true,
    isDisabled: false,
    sortOrder: 10,
  },
  {
    key: 'maintenance',
    label: 'Scheduled Maintenance',
    category: 'mechanical',
    isSystem: true,
    isDisabled: false,
    sortOrder: 20,
  },
  {
    key: 'setup',
    label: 'Setup / Threading',
    category: 'mechanical',
    isSystem: true,
    isDisabled: false,
    sortOrder: 30,
  },
  {
    key: 'changeover',
    label: 'Changeover',
    category: 'mechanical',
    isSystem: true,
    isDisabled: false,
    sortOrder: 40,
  },
  {
    key: 'quality-rejection',
    label: 'Quality Rejection',
    category: 'mechanical',
    isSystem: true,
    isDisabled: false,
    sortOrder: 50,
  },
  {
    key: 'power-cut',
    label: 'Power Cut',
    category: 'operational',
    isSystem: true,
    isDisabled: false,
    sortOrder: 60,
  },
  {
    key: 'no-order',
    label: 'No Order / Idle',
    category: 'operational',
    isSystem: true,
    isDisabled: false,
    sortOrder: 70,
  },
];
