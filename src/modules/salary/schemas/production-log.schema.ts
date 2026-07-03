import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { PRIMARY_METRICS, PrimaryMetric } from './machine.schema';

export { PRIMARY_METRICS, PrimaryMetric };

/**
 * Relocated stub (2026-07-04) — see machine.schema.ts in this same folder for
 * why this exists. Kept only so salary.service.ts's piece-rate payroll branch
 * (unreachable — MACHINES was never enabled in the ManekHR preset) compiles.
 */
@Schema({ timestamps: true, collection: 'production_logs' })
export class ProductionLog extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  assignmentId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  machineId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true, index: true })
  teamMemberId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Shift', required: false, index: true })
  shiftId?: Types.ObjectId;

  @Prop({ type: String, required: true, index: true, match: /^\d{4}-\d{2}-\d{2}$/ })
  date: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 32 })
  logCode: string;

  @Prop({ type: String, enum: PRIMARY_METRICS, required: true })
  primaryMetric: PrimaryMetric;

  @Prop({ type: Number, min: 0, default: null })
  stitchCount?: number | null;

  @Prop({ type: Number, min: 0, default: null })
  pieceCount?: number | null;

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

ProductionLogSchema.index(
  { workspaceId: 1, logCode: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);
ProductionLogSchema.index({ workspaceId: 1, date: 1, isDeleted: 1 });
ProductionLogSchema.index({ workspaceId: 1, machineId: 1, date: -1, isDeleted: 1 });
ProductionLogSchema.index({ workspaceId: 1, teamMemberId: 1, date: -1, isDeleted: 1 });
ProductionLogSchema.index({ workspaceId: 1, shiftId: 1, date: -1, isDeleted: 1 });
ProductionLogSchema.index({ assignmentId: 1, isDeleted: 1 });
