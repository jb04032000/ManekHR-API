import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export const MACHINE_STATUSES = [
  'active',
  'idle',
  'maintenance',
  'retired',
] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

export const PRIMARY_METRICS = ['stitches', 'pieces', 'hours'] as const;
export type PrimaryMetric = (typeof PRIMARY_METRICS)[number];

@Schema({ _id: false })
class MachineAttributes {
  @Prop({ type: Number }) needles?: number;
  @Prop({ type: Number }) heads?: number;
  @Prop({ type: Number }) hoopSizeMm?: number;
  @Prop({ type: Number }) maxRpm?: number;
  @Prop({ type: String }) spec?: string; // free text for non-embroidery machines
}

const MachineAttributesSchema = SchemaFactory.createForClass(MachineAttributes);

@Schema({ timestamps: true, collection: 'machines' })
export class Machine extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Location', required: true, index: true })
  locationId: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 120 })
  name: string;

  @Prop({ trim: true, maxlength: 32 })
  machineCode?: string;

  // e.g. 'embroidery', 'cutting', 'printing', 'other'
  @Prop({ required: true, trim: true, default: 'embroidery' })
  type: string;

  /**
   * Per-machine primary production metric (D-02 / MACH-P2-01a).
   * Optional — when null, ProductionLog uses type-default via
   * MachinesService.resolvePrimaryMetric().
   */
  @Prop({ type: String, enum: PRIMARY_METRICS, required: false })
  primaryMetric?: PrimaryMetric;

  /**
   * Per-machine uptime target % (Phase 25 D-07). Optional override.
   * When undefined, falls back to Workspace.productionUptimeTargetPct
   * (default 85). Resolution lives in Plan 06.
   */
  @Prop({ type: Number, min: 1, max: 100, required: false })
  uptimeTargetPct?: number;

  @Prop({ trim: true })
  model?: string;

  @Prop({ trim: true })
  manufacturer?: string;

  @Prop({ trim: true })
  serialNumber?: string;

  @Prop({
    type: String,
    enum: MACHINE_STATUSES,
    default: 'active',
    index: true,
  })
  status: MachineStatus;

  // Free-text floor tag — e.g. "Floor 2 East", "Building B Ground Floor"
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

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId;

  // F-05 Fixed Assets linkage — set when machine is added to fixed-asset register.
  @Prop({ type: Types.ObjectId, ref: 'FixedAsset' })
  fixedAssetId?: Types.ObjectId;
}

export const MachineSchema = SchemaFactory.createForClass(Machine);

// Partial-unique: (workspaceId, machineCode) when code exists, non-deleted only.
MachineSchema.index(
  { workspaceId: 1, machineCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      machineCode: { $type: 'string' },
      isDeleted: false,
    },
  },
);

// Compound index for common queries
MachineSchema.index({ workspaceId: 1, locationId: 1, status: 1 });
MachineSchema.index({ workspaceId: 1, isDeleted: 1, name: 1 });
