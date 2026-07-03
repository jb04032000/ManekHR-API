import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type JobWorkOutwardChallanDocument = HydratedDocument<JobWorkOutwardChallan>;

// ─── JwoReturnLine sub-document ───────────────────────────────────────────────

@Schema({ _id: false })
export class JwoReturnLine {
  @Prop({ type: Number, required: true })
  lineNo: number;

  @Prop({ type: Types.ObjectId, ref: 'JobWorkLot', required: true })
  jobWorkLotId: Types.ObjectId;

  /** Denormalized lot number for display */
  @Prop({ type: String, required: true, trim: true })
  lotNo: string;

  @Prop({ type: String, required: true, trim: true })
  itemDescription: string;

  @Prop({ type: Number, required: true, min: 0 })
  qtyReturning: number;

  @Prop({ type: String, required: true })
  unit: string;

  /** Line-level karigar override */
  @Prop({ type: [Types.ObjectId], ref: 'TeamMember', default: [] })
  karigarIds: Types.ObjectId[];

  @Prop({ type: [Types.ObjectId], default: [] })
  machineIds: Types.ObjectId[];
}

export const JwoReturnLineSchema = SchemaFactory.createForClass(JwoReturnLine);

// ─── JwoWastageLine sub-document ──────────────────────────────────────────────

@Schema({ _id: false })
export class JwoWastageLine {
  @Prop({ type: Number, required: true })
  lineNo: number;

  @Prop({ type: Types.ObjectId, ref: 'JobWorkLot', required: true })
  jobWorkLotId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true })
  itemDescription: string;

  @Prop({ type: Number, required: true, min: 0 })
  qtyWasted: number;

  @Prop({ type: String, required: true })
  unit: string;

  @Prop({
    type: String,
    enum: ['cutting', 'breakage', 'color_damage', 'machine_fault', 'design_rework', 'shrinkage', 'other'],
    required: true,
  })
  reasonCode: 'cutting' | 'breakage' | 'color_damage' | 'machine_fault' | 'design_rework' | 'shrinkage' | 'other';

  @Prop({ type: String })
  narration?: string;
}

export const JwoWastageLineSchema = SchemaFactory.createForClass(JwoWastageLine);

// ─── JobWorkOutwardChallan root document ──────────────────────────────────────

@Schema({ timestamps: true, collection: 'jobworkoutwardchallans' })
export class JobWorkOutwardChallan {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true })
  firmId: Types.ObjectId;

  @Prop({ type: String, default: 'job_work_out' })
  voucherType: string;

  /**
   * From VoucherSeries 'job_work_out'. Default '' on draft; assigned on post.
   * Partial unique index prevents collision across multiple drafts with empty voucherNumber.
   */
  @Prop({ type: String, trim: true, default: '' })
  voucherNumber: string;

  @Prop({ type: Date, required: true })
  voucherDate: Date;

  @Prop({
    type: String,
    enum: ['draft', 'posted', 'cancelled'],
    default: 'draft',
    required: true,
  })
  status: 'draft' | 'posted' | 'cancelled';

  /** Same principal as JWI */
  @Prop({ type: Types.ObjectId, ref: 'Party', required: true })
  partyId: Types.ObjectId;

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

  @Prop({ type: [JwoReturnLineSchema], default: [] })
  returnLines: JwoReturnLine[];

  @Prop({ type: [JwoWastageLineSchema], default: [] })
  wastageLines: JwoWastageLine[];

  /** Karigar attribution (who performed the embroidery work on returned lots) */
  @Prop({ type: [Types.ObjectId], ref: 'TeamMember', required: true, default: [] })
  karigarIds: Types.ObjectId[];

  @Prop({ type: [Types.ObjectId], default: [] })
  machineIds: Types.ObjectId[];

  @Prop({ type: Types.ObjectId, ref: 'Shift' })
  shiftId?: Types.ObjectId;

  /** Null on draft; filled when posted (auto-creates draft JW invoice) */
  @Prop({ type: Types.ObjectId, ref: 'JobWorkInvoice' })
  jwInvoiceId?: Types.ObjectId;

  /**
   * F-11 W4: manual place-of-supply override (e.g. party's state code).
   * Persisted on the schema so draft → post round-trip preserves the value.
   * Priority at post: jwo.placeOfSupplyStateCode → party.gstin[0:2] → firm.gstin[0:2].
   */
  @Prop({ type: String })
  placeOfSupplyStateCode?: string;

  @Prop({ type: String })
  narration?: string;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;
}

export const JobWorkOutwardChallanSchema = SchemaFactory.createForClass(JobWorkOutwardChallan);

// D-03 indexes
JobWorkOutwardChallanSchema.index({ workspaceId: 1, firmId: 1, status: 1 });
JobWorkOutwardChallanSchema.index({ workspaceId: 1, firmId: 1, partyId: 1, voucherDate: -1 });
JobWorkOutwardChallanSchema.index({ workspaceId: 1, firmId: 1, jwInvoiceId: 1 });
JobWorkOutwardChallanSchema.index(
  { workspaceId: 1, firmId: 1, voucherNumber: 1 },
  { unique: true, partialFilterExpression: { voucherNumber: { $type: 'string', $ne: '' } } },
);
