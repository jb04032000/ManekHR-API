import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class PartySalesAggregate extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  partyId: Types.ObjectId;

  /** e.g. "2025-26" */
  @Prop({ type: String, required: true })
  financialYear: string;

  /** Cumulative taxable sales in paise for this party in this FY */
  @Prop({ type: Number, default: 0 })
  totalSalesPaise: number;
}

export const PartySalesAggregateSchema = SchemaFactory.createForClass(PartySalesAggregate);

// Compound unique index: one row per (firm, party, FY)
PartySalesAggregateSchema.index(
  { firmId: 1, partyId: 1, financialYear: 1 },
  { unique: true },
);
// For cross-firm query isolation (T-F02-02-03)
PartySalesAggregateSchema.index({ workspaceId: 1, firmId: 1 });
