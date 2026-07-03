import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Relocated stub (2026-07-04) — the Machines module was removed (owner
 * directive: no use for this business). This schema is kept ONLY because
 * salary.service.ts still injects a `Machine` model for its piece-rate payroll
 * branch (`salaryType === 'piece_rate'`), which is unreachable in practice:
 * the piece-rate endpoints are gated behind `@RequireSubscription({ module:
 * MACHINES, subFeature: 'piece_rate_payroll' })`, and MACHINES has never been
 * enabled in the ManekHR module preset. Do not re-wire this into a live
 * Machines feature; the collection is expected to stay permanently empty.
 */
export const MACHINE_STATUSES = ['active', 'idle', 'maintenance', 'retired'] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

export const PRIMARY_METRICS = ['stitches', 'pieces', 'hours'] as const;
export type PrimaryMetric = (typeof PRIMARY_METRICS)[number];

@Schema({ _id: false })
class MachineAttributes {
  @Prop({ type: Number }) needles?: number;
  @Prop({ type: Number }) heads?: number;
  @Prop({ type: Number }) hoopSizeMm?: number;
  @Prop({ type: Number }) maxRpm?: number;
  @Prop({ type: String }) spec?: string;
}

const MachineAttributesSchema = SchemaFactory.createForClass(MachineAttributes);

@Schema({ timestamps: true, collection: 'machines' })
export class Machine extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  locationId: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 120 })
  name: string;

  @Prop({ trim: true, maxlength: 32 })
  machineCode?: string;

  @Prop({ required: true, trim: true, default: 'embroidery' })
  type: string;

  @Prop({ type: String, enum: PRIMARY_METRICS, required: false })
  primaryMetric?: PrimaryMetric;

  @Prop({ type: Number, min: 1, max: 100, required: false })
  uptimeTargetPct?: number;

  @Prop({ trim: true })
  model?: string;

  @Prop({ trim: true })
  manufacturer?: string;

  @Prop({ trim: true })
  serialNumber?: string;

  @Prop({ type: String, enum: MACHINE_STATUSES, default: 'active', index: true })
  status: MachineStatus;

  @Prop({ trim: true, maxlength: 60 })
  floorTag?: string;

  @Prop({ type: MachineAttributesSchema, default: {} })
  attributes: MachineAttributes;

  @Prop({ type: Date })
  installedOn?: Date;

  @Prop({ type: Date })
  lastMaintenanceDate?: Date;

  @Prop({ type: Number, min: 1 })
  maintenanceIntervalDays?: number;

  @Prop({ trim: true })
  notes?: string;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;

  @Prop({ type: Types.ObjectId })
  createdBy?: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  fixedAssetId?: Types.ObjectId;
}

export const MachineSchema = SchemaFactory.createForClass(Machine);

MachineSchema.index(
  { workspaceId: 1, machineCode: 1 },
  { unique: true, partialFilterExpression: { machineCode: { $type: 'string' }, isDeleted: false } },
);
MachineSchema.index({ workspaceId: 1, locationId: 1, status: 1 });
MachineSchema.index({ workspaceId: 1, isDeleted: 1, name: 1 });
