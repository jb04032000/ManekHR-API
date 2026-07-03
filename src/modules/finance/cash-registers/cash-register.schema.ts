import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class CashRegister extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String, enum: ['main', 'petty_cash'], default: 'main' })
  type: string;

  @Prop({ type: Number })
  imprestAmount?: number;

  @Prop({ type: Number, default: 0 })
  currentBalance: number;

  @Prop({ type: Boolean, default: false })
  isDefault: boolean;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;

  /** Day-end denomination breakdown for cash tally (Pitfall 4 support) */
  @Prop({
    type: [{ denomination: { type: Number }, count: { type: Number } }],
    default: [],
  })
  denominationBreakdown: { denomination: number; count: number }[];

  /** Alert threshold in paise — replenishment alert fires when currentBalance falls below this */
  @Prop({ type: Number })
  lowWaterThresholdPaise?: number;

  /** Timestamp of last day-end denomination tally */
  @Prop({ type: Date })
  lastTallyAt?: Date;
}

export const CashRegisterSchema = SchemaFactory.createForClass(CashRegister);
CashRegisterSchema.index({ firmId: 1, isDefault: 1 });
CashRegisterSchema.index({ workspaceId: 1, firmId: 1, isDeleted: 1 });
