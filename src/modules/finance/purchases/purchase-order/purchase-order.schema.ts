import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ _id: false })
export class PurchaseOrderLineItem {
  @Prop({ type: Types.ObjectId }) itemId?: Types.ObjectId;
  @Prop({ type: String }) itemName?: string;
  @Prop({ type: String }) hsnSacCode?: string;
  @Prop({ type: Number }) qty?: number;
  @Prop({ type: String }) unit?: string;
  @Prop({ type: Number }) ratePaise?: number;
  @Prop({ type: Number, default: 0 }) discountPct?: number;
  @Prop({ type: Number }) taxRate?: number;
  @Prop({ type: Number }) lineTotalPaise?: number;
  @Prop({ type: Boolean, default: false }) isCapitalGoods?: boolean;
}
export const PurchaseOrderLineItemSchema = SchemaFactory.createForClass(PurchaseOrderLineItem);

interface POAuditEntry {
  at: Date;
  by: Types.ObjectId;
  action: string;
  reason?: string;
}

@Schema({ timestamps: true })
export class PurchaseOrder extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true }) workspaceId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true, index: true }) firmId: Types.ObjectId;
  @Prop({ type: String, enum: ['purchase_order'], default: 'purchase_order' }) voucherType: string;
  @Prop({ type: String, index: true }) voucherNumber?: string;
  @Prop({ type: Date, required: true }) voucherDate: Date;
  @Prop({ type: String, required: true }) financialYear: string;
  @Prop({ type: String, enum: ['draft', 'confirmed', 'cancelled'], default: 'draft' }) state: string;

  @Prop({ type: Types.ObjectId, ref: 'Party' }) partyId?: Types.ObjectId;
  @Prop({ type: Object, default: {} }) partySnapshot?: Record<string, any>;
  @Prop({ type: String }) placeOfSupplyStateCode?: string;
  @Prop({ type: Date }) expectedDeliveryDate?: Date;

  @Prop({ type: [PurchaseOrderLineItemSchema], default: [] }) lineItems: PurchaseOrderLineItem[];

  @Prop({ type: Number, default: 0 }) taxableValuePaise: number;
  @Prop({ type: Number, default: 0 }) cgstPaise: number;
  @Prop({ type: Number, default: 0 }) sgstPaise: number;
  @Prop({ type: Number, default: 0 }) igstPaise: number;
  @Prop({ type: Number, default: 0 }) grandTotalPaise: number;

  @Prop({ type: String }) notes?: string;
  @Prop({ type: Types.ObjectId }) confirmedBy?: Types.ObjectId;
  @Prop({ type: Date }) confirmedAt?: Date;
  @Prop({ type: Array, default: [] }) auditLog: POAuditEntry[];
  @Prop({ type: Boolean, default: false }) isDeleted: boolean;
  @Prop({ type: Date }) deletedAt?: Date;
}

export const PurchaseOrderSchema = SchemaFactory.createForClass(PurchaseOrder);
PurchaseOrderSchema.index({ workspaceId: 1, firmId: 1, voucherDate: -1 });
PurchaseOrderSchema.index({ workspaceId: 1, firmId: 1, partyId: 1, state: 1 });
PurchaseOrderSchema.index({ workspaceId: 1, firmId: 1, state: 1, voucherDate: -1 });
