import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// ─── BomComponent sub-document ────────────────────────────────────────────────

@Schema({ _id: false })
export class BomComponent {
  @Prop({ type: Types.ObjectId, ref: 'Item', required: true })
  itemId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 0 })
  qty: number;

  @Prop({ type: String, required: true })
  unit: string;

  @Prop({ type: Number, default: 0, min: 0, max: 100 })
  wastageAllowedPct: number;

  @Prop({ type: Boolean, default: false })
  isSubAssembly: boolean;

  @Prop({ type: Types.ObjectId })
  subBomId?: Types.ObjectId;

  @Prop({ type: Number, default: 0 })
  sortOrder: number;
}

export const BomComponentSchema = SchemaFactory.createForClass(BomComponent);

// ─── BomByProduct sub-document ────────────────────────────────────────────────

@Schema({ _id: false })
export class BomByProduct {
  @Prop({ type: Types.ObjectId, ref: 'Item', required: true })
  itemId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 0 })
  qty: number;

  @Prop({ type: String, required: true })
  unit: string;

  @Prop({ type: Number, required: true, min: 0 })
  nrvPaisePerUnit: number;
}

export const BomByProductSchema = SchemaFactory.createForClass(BomByProduct);

// ─── BomDefinition document ───────────────────────────────────────────────────

export type BomDefinitionDocument = HydratedDocument<BomDefinition>;

@Schema({ timestamps: true })
export class BomDefinition {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Firm', required: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Item', required: true })
  finishedItemId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 0 })
  outputQty: number;

  @Prop({ type: String, required: true })
  outputUnit: string;

  @Prop({ type: Number, required: true, min: 0, max: 100, default: 100 })
  yieldPct: number;

  @Prop({ type: Number, required: true, default: 1 })
  versionNo: number;

  @Prop({ type: Boolean, default: false })
  isDefault: boolean;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: [BomComponentSchema], default: [] })
  components: BomComponent[];

  @Prop({ type: [BomByProductSchema], default: [] })
  byProducts: BomByProduct[];

  @Prop({ type: Number })
  additionalCostEstimate?: number;

  /** Cached standard cost in paise — computed on demand via GET /standard-cost (D-05). */
  @Prop({ type: Number })
  standardCostPaise?: number;

  @Prop({ type: String })
  narration?: string;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  updatedBy: Types.ObjectId;
}

export const BomDefinitionSchema = SchemaFactory.createForClass(BomDefinition);

// ─── Indexes (D-01) ───────────────────────────────────────────────────────────

// find default BoM for an item
BomDefinitionSchema.index({ workspaceId: 1, firmId: 1, finishedItemId: 1, isDefault: 1 });
// list BoMs (workspace + firm scoped, soft-delete filter)
BomDefinitionSchema.index({ workspaceId: 1, firmId: 1, isDeleted: 1 });
// version history
BomDefinitionSchema.index({ workspaceId: 1, firmId: 1, finishedItemId: 1, versionNo: 1 });
