import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { PRIMARY_METRICS, PrimaryMetric } from '../../machines/schemas/machine.schema';

export { PRIMARY_METRICS, PrimaryMetric };

@Schema({ timestamps: true, collection: 'production_logs' })
export class ProductionLog extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'MachineShiftAssignment', required: true, index: true })
  assignmentId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Machine', required: true, index: true })
  machineId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true, index: true })
  teamMemberId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Shift', required: false, index: true })
  shiftId?: Types.ObjectId;

  // YYYY-MM-DD in workspace timezone (D-01)
  @Prop({ type: String, required: true, index: true, match: /^\d{4}-\d{2}-\d{2}$/ })
  date: string;

  // PROD-001 — assigned at create time from WorkspaceCounter (D-04)
  @Prop({ type: String, required: true, trim: true, maxlength: 32 })
  logCode: string;

  // Snapshot of machine's primaryMetric AT CREATE TIME (Pitfall 5)
  @Prop({ type: String, enum: PRIMARY_METRICS, required: true })
  primaryMetric: PrimaryMetric;

  @Prop({ type: Number, min: 0, default: null })
  stitchCount?: number | null;

  @Prop({ type: Number, min: 0, default: null })
  pieceCount?: number | null;

  // Decimal 2dp; service layer rounds before persist
  @Prop({ type: Number, min: 0, max: 24, default: null })
  hoursLogged?: number | null;

  @Prop({ type: String, trim: true, maxlength: 500 })
  notes?: string;

  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  updatedBy?: Types.ObjectId;
}

export const ProductionLogSchema = SchemaFactory.createForClass(ProductionLog);

// Per-workspace partial-unique on logCode (PROD-001 collision avoidance)
ProductionLogSchema.index(
  { workspaceId: 1, logCode: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);

// Phase 25 dashboard prep + Phase 21 read paths
ProductionLogSchema.index({ workspaceId: 1, date: 1, isDeleted: 1 });
ProductionLogSchema.index({ workspaceId: 1, machineId: 1, date: -1, isDeleted: 1 });
ProductionLogSchema.index({ workspaceId: 1, teamMemberId: 1, date: -1, isDeleted: 1 });
ProductionLogSchema.index({ workspaceId: 1, shiftId: 1, date: -1, isDeleted: 1 });
ProductionLogSchema.index({ assignmentId: 1, isDeleted: 1 });
