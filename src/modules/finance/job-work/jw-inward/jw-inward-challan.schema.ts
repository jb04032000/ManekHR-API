import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type JobWorkInwardChallanDocument = HydratedDocument<JobWorkInwardChallan>;

// ─── JwiLine sub-document ──────────────────────────────────────────────────────

@Schema({ _id: false })
export class JwiLine {
  @Prop({ type: Number, required: true })
  lineNo: number;

  @Prop({ type: String, required: true, trim: true })
  itemDescription: string;

  @Prop({ type: String, trim: true })
  hsnCode?: string;

  @Prop({ type: Number, required: true, min: 0 })
  qty: number;

  @Prop({ type: String, required: true })
  unit: string;

  @Prop({ type: String, trim: true })
  vehicleNo?: string;

  /** Null on draft; filled when challan is posted */
  @Prop({ type: Types.ObjectId, ref: 'JobWorkLot' })
  jobWorkLotId?: Types.ObjectId;

  @Prop({ type: String })
  narration?: string;

  /** Line-level karigar override (higher specificity than header) */
  @Prop({ type: [Types.ObjectId], ref: 'TeamMember', default: [] })
  karigarIds: Types.ObjectId[];

  @Prop({ type: [Types.ObjectId], default: [] })
  machineIds: Types.ObjectId[];
}

export const JwiLineSchema = SchemaFactory.createForClass(JwiLine);

// ─── JobWorkInwardChallan root document ───────────────────────────────────────

@Schema({ timestamps: true, collection: 'jobworkinwardchallans' })
export class JobWorkInwardChallan {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true })
  firmId: Types.ObjectId;

  @Prop({ type: String, default: 'job_work_in' })
  voucherType: string;

  /**
   * From VoucherSeries 'job_work_in'. Default '' on draft; assigned on post.
   * Partial unique index prevents collision across multiple drafts with empty voucherNumber.
   */
  @Prop({ type: String, trim: true, default: '' })
  voucherNumber: string;

  @Prop({ type: Date, required: true })
  voucherDate: Date;

  @Prop({
    type: String,
    enum: ['draft', 'posted', 'closed'],
    default: 'draft',
    required: true,
  })
  status: 'draft' | 'posted' | 'closed';

  /** Principal party (the trader who sent material) */
  @Prop({ type: Types.ObjectId, ref: 'Party', required: true })
  partyId: Types.ObjectId;

  /** GSTIN, name, address at time of post */
  @Prop({ type: Object })
  partySnapshot?: Record<string, any>;

  @Prop({ type: String, trim: true })
  vehicleNo?: string;

  @Prop({ type: String, trim: true })
  transporterName?: string;

  @Prop({ type: String, trim: true })
  transporterGSTIN?: string;

  /** Lorry receipt number */
  @Prop({ type: String, trim: true })
  lrNo?: string;

  @Prop({ type: [JwiLineSchema], default: [] })
  lines: JwiLine[];

  /** Header-level karigar attribution (optional — can tag who will work on this batch) */
  @Prop({ type: [Types.ObjectId], ref: 'TeamMember', default: [] })
  karigarIds: Types.ObjectId[];

  @Prop({ type: [Types.ObjectId], default: [] })
  machineIds: Types.ObjectId[];

  @Prop({ type: Types.ObjectId, ref: 'Shift' })
  shiftId?: Types.ObjectId;

  @Prop({ type: String })
  narration?: string;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;
}

export const JobWorkInwardChallanSchema = SchemaFactory.createForClass(JobWorkInwardChallan);

// D-02 indexes
JobWorkInwardChallanSchema.index({ workspaceId: 1, firmId: 1, status: 1 });
JobWorkInwardChallanSchema.index({ workspaceId: 1, firmId: 1, partyId: 1, voucherDate: -1 });
JobWorkInwardChallanSchema.index(
  { workspaceId: 1, firmId: 1, voucherNumber: 1 },
  { unique: true, partialFilterExpression: { voucherNumber: { $type: 'string', $ne: '' } } },
);
