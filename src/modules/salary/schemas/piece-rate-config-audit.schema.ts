import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Phase 23 (D-08 / BLOCKER 2) — persistent audit trail for piece-rate
 * config changes (set + clear).
 *
 * Why a dedicated collection (not SalaryAdjustment): SalaryAdjustment
 * requires salaryId + monetary amount + addition/deduction type, which
 * are structurally incompatible with a config-change event.
 *
 * Each set/clear emits one document with `before` (null on first set) and
 * `after` (null on clear) snapshots of the pieceRateConfig payload.
 */

export type PieceRateConfigAuditType = 'piece_rate_config_change';

export interface PieceRateConfigAuditPayload {
  unit: string;
  defaultRate: number;
  basePortion: number;
  perMachineOverrides: { machineId: Types.ObjectId | string; rate: number }[];
  effectiveFrom: Date | string;
}

@Schema({
  collection: 'piece_rate_config_audit',
  timestamps: { createdAt: 'changedAt', updatedAt: false },
})
export class PieceRateConfigAudit extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true, index: true })
  teamMemberId: Types.ObjectId;

  @Prop({
    type: String,
    enum: ['piece_rate_config_change'],
    required: true,
  })
  type: PieceRateConfigAuditType;

  @Prop({ type: Object, default: null })
  before: PieceRateConfigAuditPayload | null;

  @Prop({ type: Object, default: null })
  after: PieceRateConfigAuditPayload | null;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  changedByUserId: Types.ObjectId;

  changedAt?: Date;
}

export const PieceRateConfigAuditSchema = SchemaFactory.createForClass(
  PieceRateConfigAudit,
);
PieceRateConfigAuditSchema.index({
  workspaceId: 1,
  teamMemberId: 1,
  changedAt: -1,
});
