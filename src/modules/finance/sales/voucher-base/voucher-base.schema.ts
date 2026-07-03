import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  VoucherState,
  VoucherType,
  LineItem,
  AdditionalCharge,
  AuditEntry,
  LinkedDoc,
} from './voucher-base.interface';

/**
 * VoucherBaseSchema — embedded schema definition fragment shared across all 5 voucher types.
 * Spread this into each voucher's @Schema class instead of extending a base class
 * (Mongoose does not support class inheritance for schemas).
 *
 * Per F-02 D-22.
 */
@Schema({ _id: false })
export class VoucherBase {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({
    type: String,
    enum: ['quotation', 'sale_order', 'proforma', 'delivery_challan', 'sale_invoice'],
    required: true,
  })
  voucherType: VoucherType;

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

  @Prop({ type: Types.ObjectId, ref: 'Party', index: true })
  partyId?: Types.ObjectId;

  @Prop({ type: Object })
  partySnapshot?: Record<string, any>;

  @Prop({ type: String })
  placeOfSupplyStateCode?: string;

  @Prop({
    type: {
      termsDays: { type: Number },
      dueDate: { type: Date },
    },
  })
  paymentTerms?: { termsDays: number; dueDate?: Date };

  @Prop({
    type: [
      {
        itemId: { type: Types.ObjectId, ref: 'Item' },
        itemName: { type: String },
        hsnSacCode: { type: String },
        qty: { type: Number },
        unit: { type: String },
        // R11 textile dual-unit breakdown (display/print only; qty stays authoritative).
        secondaryQty: { type: Number },
        secondaryUnit: { type: String },
        conversionFactor: { type: Number },
        // R11 inventory metadata: persisted so the chosen lot/godown survives to post time,
        // where InventoryService.stockOut decrements that exact lot (it already reads line.lotId).
        godownId: { type: Types.ObjectId, ref: 'Godown' },
        lotId: { type: Types.ObjectId, ref: 'Lot' },
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

  @Prop({ type: Types.ObjectId })
  postedBy?: Types.ObjectId;

  @Prop({ type: Date })
  cancelledAt?: Date;

  @Prop({ type: Types.ObjectId })
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
}

export const VoucherBaseSchema = SchemaFactory.createForClass(VoucherBase);
