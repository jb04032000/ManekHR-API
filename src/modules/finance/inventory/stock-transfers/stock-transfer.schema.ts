import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type StockTransferDocument = HydratedDocument<StockTransfer>;

@Schema({ _id: false })
export class StockTransferLine {
  @Prop({ type: Types.ObjectId, ref: 'Item', required: true })
  itemId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Lot' })
  lotId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Batch' })
  batchId?: Types.ObjectId;

  @Prop({ type: [String], default: [] })
  serialNos: string[];

  @Prop({ type: Number, required: true, min: 0 })
  qty: number;

  @Prop({ type: String, maxlength: 500 })
  narration?: string;
}

export const StockTransferLineSchema = SchemaFactory.createForClass(StockTransferLine);

@Schema({ _id: false })
export class StockTransferAuditEntry {
  @Prop({ type: Date, default: Date.now })
  at: Date;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  by: Types.ObjectId;

  @Prop({ type: String, required: true })
  action: string; // 'created' | 'updated' | 'posted' | 'deleted'

  @Prop({ type: Object })
  before?: any;

  @Prop({ type: Object })
  after?: any;
}

export const StockTransferAuditEntrySchema = SchemaFactory.createForClass(StockTransferAuditEntry);

@Schema({ collection: 'stock_transfers', timestamps: true })
export class StockTransfer {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: String, required: true })
  voucherNo: string; // ST/{FY}/{seq}

  @Prop({ type: Date, required: true })
  date: Date;

  @Prop({ type: Types.ObjectId, ref: 'Godown', required: true })
  fromGodownId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Godown', required: true })
  toGodownId: Types.ObjectId;

  @Prop({ type: [StockTransferLineSchema], default: [] })
  lines: StockTransferLine[];

  @Prop({ type: String, maxlength: 1000 })
  narration?: string;

  @Prop({ type: String, enum: ['draft', 'posted'], default: 'draft' })
  status: 'draft' | 'posted';

  @Prop({ type: Types.ObjectId, ref: 'User' })
  postedBy?: Types.ObjectId;

  @Prop({ type: Date })
  postedAt?: Date;

  @Prop({ type: [StockTransferAuditEntrySchema], default: [] })
  auditLog: StockTransferAuditEntry[];

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const StockTransferSchema = SchemaFactory.createForClass(StockTransfer);

// Compound unique index: voucherNo must be unique per firm
StockTransferSchema.index(
  { workspaceId: 1, firmId: 1, voucherNo: 1 },
  { unique: true },
);

// Date-desc listing per firm
StockTransferSchema.index({ workspaceId: 1, firmId: 1, date: -1 });

// Status filter queries
StockTransferSchema.index({ workspaceId: 1, firmId: 1, status: 1 });
