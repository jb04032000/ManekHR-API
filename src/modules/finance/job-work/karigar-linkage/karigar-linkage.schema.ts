import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type KarigarLinkageDocument = HydratedDocument<KarigarLinkage>;

@Schema({ timestamps: true, collection: 'karigarlinkages' })
export class KarigarLinkage {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true })
  sourceVoucherId: Types.ObjectId;

  @Prop({
    type: String,
    enum: ['job_work_in', 'job_work_out', 'job_work_invoice', 'manufacturing_voucher'],
    required: true,
  })
  sourceVoucherType: 'job_work_in' | 'job_work_out' | 'job_work_invoice' | 'manufacturing_voucher';

  /** Which line of the source voucher (if line-level attribution) */
  @Prop({ type: Number })
  sourceLineIndex?: number;

  @Prop({ type: Date, required: true })
  voucherDate: Date;

  /** TeamMember.isKarigar must be true */
  @Prop({ type: Types.ObjectId, ref: 'TeamMember', required: true })
  karigarId: Types.ObjectId;

  /** Machine ObjectId — Machine entity arrives in Machines module v2.0 */
  @Prop({ type: Types.ObjectId })
  machineId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Shift' })
  shiftId?: Types.ObjectId;

  /** TeamMember.karigarDailyRatePaise snapshotted at post time — not retroactively updated */
  @Prop({ type: Number, required: true, default: 0 })
  wageRateSnapshotPaise: number;

  /** User can enter actual hours worked on this lot */
  @Prop({ type: Number })
  estimatedHours?: number;

  /**
   * If hours provided: wageRate × (hours/8); else: wageRate ÷ karigar count.
   * Computed in service at post time.
   */
  @Prop({ type: Number, required: true, default: 0 })
  estimatedCostPaise: number;

  /** Which lot this karigar worked on (if line-level attribution) */
  @Prop({ type: Types.ObjectId, ref: 'JobWorkLot' })
  jobWorkLotId?: Types.ObjectId;
}

export const KarigarLinkageSchema = SchemaFactory.createForClass(KarigarLinkage);

// D-05 indexes
KarigarLinkageSchema.index({ workspaceId: 1, firmId: 1, karigarId: 1, voucherDate: -1 });
KarigarLinkageSchema.index({ workspaceId: 1, firmId: 1, sourceVoucherId: 1 });
KarigarLinkageSchema.index(
  { workspaceId: 1, firmId: 1, machineId: 1, voucherDate: -1 },
  { partialFilterExpression: { machineId: { $exists: true } } },
);
