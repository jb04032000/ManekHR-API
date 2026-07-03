import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import type {
  VoucherState,
  LineItem,
  AdditionalCharge,
  AuditEntry,
  LinkedDoc,
} from '../voucher-base/voucher-base.interface';

@Schema({ timestamps: true })
export class SaleOrder extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: String, default: 'sale_order' })
  voucherType: string;

  @Prop({ type: String, index: true })
  voucherNumber?: string;

  @Prop({ type: Date, required: true })
  voucherDate: Date;

  @Prop({
    type: String,
    enum: ['draft', 'pending_approval', 'posted', 'cancelled', 'void'],
    default: 'draft',
    index: true,
  })
  state: VoucherState;

  @Prop({ type: Types.ObjectId, ref: 'Party', required: true, index: true })
  partyId: Types.ObjectId;

  @Prop({ type: Object })
  partySnapshot?: Record<string, any>;

  @Prop({ type: String })
  placeOfSupplyStateCode?: string;

  @Prop({ type: Object })
  paymentTerms?: { dueDays?: number; label?: string };

  @Prop({
    type: [
      {
        itemId: { type: Types.ObjectId, ref: 'Item' },
        itemName: { type: String },
        hsnSacCode: { type: String },
        qty: { type: Number },
        unit: { type: String },
        ratePaise: { type: Number },
        discountPct: { type: Number, default: 0 },
        discountFlatPaise: { type: Number },
        taxRate: { type: Number, enum: [0, 5, 12, 18, 28] },
        cessRate: { type: Number, default: 0 },
        isTaxInclusive: { type: Boolean, default: false },
        taxableValuePaise: { type: Number },
        cgstPaise: { type: Number },
        sgstPaise: { type: Number },
        igstPaise: { type: Number },
        cessPaise: { type: Number },
        lineTotalPaise: { type: Number },
      },
    ],
    default: [],
  })
  lineItems: LineItem[];

  @Prop({
    type: [
      {
        label: { type: String },
        amountPaise: { type: Number },
        isTaxable: { type: Boolean, default: false },
        taxRate: { type: Number, enum: [0, 5, 12, 18, 28] },
      },
    ],
    default: [],
  })
  additionalCharges: AdditionalCharge[];

  @Prop({ type: String })
  notes?: string;

  @Prop({ type: String })
  internalNotes?: string;

  @Prop({ type: [String], default: [] })
  attachments: string[];

  @Prop({
    type: [
      {
        voucherType: {
          type: String,
          enum: ['quotation', 'sale_order', 'proforma', 'delivery_challan', 'sale_invoice'],
        },
        voucherId: { type: Types.ObjectId },
        voucherNumber: { type: String },
      },
    ],
    default: [],
  })
  linkedDocs: LinkedDoc[];

  @Prop({ type: String, index: true })
  idempotencyKey?: string;

  @Prop({ type: Date })
  draftCreatedAt?: Date;

  @Prop({ type: Date })
  draftUpdatedAt?: Date;

  @Prop({ type: Date })
  postedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  postedBy?: Types.ObjectId;

  @Prop({ type: Date })
  cancelledAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  cancelledBy?: Types.ObjectId;

  @Prop({ type: String })
  cancellationReason?: string;

  @Prop({
    type: [
      {
        at: { type: Date, required: true },
        by: { type: Types.ObjectId, required: true },
        action: { type: String, required: true },
        before: { type: Object },
        after: { type: Object },
        reason: { type: String },
      },
    ],
    default: [],
  })
  auditLog: AuditEntry[];

  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;

  // SaleOrder-specific fields
  @Prop({ type: Date })
  expectedDeliveryDate?: Date;

  @Prop({
    type: String,
    enum: ['open', 'partially_converted', 'fully_converted', 'cancelled'],
    default: 'open',
  })
  conversionStatus: string;
}

export const SaleOrderSchema = SchemaFactory.createForClass(SaleOrder);
SaleOrderSchema.index({ workspaceId: 1, firmId: 1, voucherDate: -1 });
SaleOrderSchema.index({ workspaceId: 1, firmId: 1, voucherNumber: 1 });
