import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ _id: false })
export class GrnLineItem {
  @Prop({ type: Types.ObjectId }) itemId?: Types.ObjectId;
  @Prop({ type: String }) itemName?: string;
  @Prop({ type: Number }) qtyOrdered?: number;       // from PO if linked
  @Prop({ type: Number }) qtyReceived?: number;      // actual received
  @Prop({ type: String }) unit?: string;
  @Prop({ type: Number }) ratePaise?: number;        // snapshot from PO
  @Prop({ type: String }) batchNumber?: string;
  @Prop({ type: String }) notes?: string;
}
export const GrnLineItemSchema = SchemaFactory.createForClass(GrnLineItem);

interface GrnAuditEntry {
  at: Date;
  by: Types.ObjectId;
  action: string;
  reason?: string;
}

@Schema({ timestamps: true, collection: 'grns' })
export class GoodsReceiptNote extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true }) workspaceId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true, index: true }) firmId: Types.ObjectId;
  @Prop({ type: String, enum: ['grn'], default: 'grn' }) voucherType: string;
  @Prop({ type: String, index: true }) voucherNumber?: string;
  @Prop({ type: Date, required: true }) voucherDate: Date;
  @Prop({ type: String, required: true }) financialYear: string;
  @Prop({ type: String, enum: ['draft', 'received', 'cancelled'], default: 'draft' }) state: string;

  @Prop({ type: Types.ObjectId, ref: 'Party' }) partyId?: Types.ObjectId;
  @Prop({ type: Object, default: {} }) partySnapshot?: Record<string, any>;

  @Prop({ type: Types.ObjectId }) sourcePoId?: Types.ObjectId;
  @Prop({ type: String }) sourcePoNumber?: string;

  // Vendor's own delivery note reference
  @Prop({ type: String }) vendorDeliveryNoteNumber?: string;
  @Prop({ type: Date }) vendorDeliveryNoteDate?: Date;

  @Prop({ type: [GrnLineItemSchema], default: [] }) lineItems: GrnLineItem[];

  @Prop({ type: String }) notes?: string;
  @Prop({ type: Types.ObjectId }) receivedBy?: Types.ObjectId;
  @Prop({ type: Date }) receivedAt?: Date;
  @Prop({ type: Array, default: [] }) auditLog: GrnAuditEntry[];
  @Prop({ type: Boolean, default: false }) isDeleted: boolean;
  @Prop({ type: Date }) deletedAt?: Date;
}

export const GoodsReceiptNoteSchema = SchemaFactory.createForClass(GoodsReceiptNote);
GoodsReceiptNoteSchema.index({ workspaceId: 1, firmId: 1, voucherDate: -1 });
GoodsReceiptNoteSchema.index({ workspaceId: 1, firmId: 1, sourcePoId: 1 });
GoodsReceiptNoteSchema.index({ workspaceId: 1, firmId: 1, partyId: 1, state: 1 });
