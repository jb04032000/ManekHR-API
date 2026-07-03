import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type JobWorkLotDocument = HydratedDocument<JobWorkLot>;

@Schema({ timestamps: true, collection: 'jobworklots' })
export class JobWorkLot {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true })
  firmId: Types.ObjectId;

  /** Principal party (the trader/manufacturer who owns this material) */
  @Prop({ type: Types.ObjectId, ref: 'Party', required: true })
  principalPartyId: Types.ObjectId;

  /** Parent JWI challan that introduced this lot */
  @Prop({ type: Types.ObjectId, ref: 'JobWorkInwardChallan', required: true })
  inwardChallanId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 0 })
  challanLineIndex: number;

  /** Auto: "JWL-{YYYYMMDD}-{seq}" or user-supplied */
  @Prop({ type: String, required: true, trim: true })
  lotNo: string;

  @Prop({ type: String, required: true, trim: true })
  itemDescription: string;

  @Prop({ type: String, trim: true })
  hsnCode?: string;

  @Prop({ type: String, required: true })
  unit: string;

  @Prop({ type: Number, required: true, min: 0 })
  qtyInward: number;

  @Prop({ type: Number, default: 0, min: 0 })
  qtyReturnedGood: number;

  @Prop({ type: Number, default: 0, min: 0 })
  qtyWasted: number;

  /** Always = qtyInward - qtyReturnedGood - qtyWasted; enforced in service */
  @Prop({ type: Number, required: true, min: 0 })
  qtyRemaining: number;

  /** Physical custody location — for tracking only; does NOT affect GodownBalance (D-11) */
  @Prop({ type: Types.ObjectId, ref: 'Godown', required: true })
  godownId: Types.ObjectId;

  @Prop({ type: Date, required: true })
  inwardDate: Date;

  /** inwardDate + 365 days (Section 143 CGST) */
  @Prop({ type: Date, required: true })
  dueReturnDate: Date;

  @Prop({
    type: String,
    enum: ['pending', 'partial', 'closed', 'deemed_supply'],
    default: 'pending',
    required: true,
  })
  status: 'pending' | 'partial' | 'closed' | 'deemed_supply';

  @Prop({ type: Date })
  deemedSupplyFlaggedAt?: Date;

  /** Tracks last warning email send date — used by deemed-supply cron for 7-day dedup (RESEARCH Open Q3) */
  @Prop({ type: Date })
  lastWarningSentAt?: Date;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;
}

export const JobWorkLotSchema = SchemaFactory.createForClass(JobWorkLot);

// D-01 indexes
JobWorkLotSchema.index({ workspaceId: 1, firmId: 1, principalPartyId: 1, status: 1 });
JobWorkLotSchema.index({ workspaceId: 1, firmId: 1, dueReturnDate: 1, status: 1 });
JobWorkLotSchema.index({ workspaceId: 1, firmId: 1, inwardChallanId: 1 });
JobWorkLotSchema.index({ workspaceId: 1, firmId: 1, lotNo: 1 }, { unique: true });
