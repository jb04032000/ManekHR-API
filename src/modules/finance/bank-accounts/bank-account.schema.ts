import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class BankAccount extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  /** e.g., "HDFC Current A/c" */
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  bankName: string;

  /**
   * NOTE: T-F06W1-03 — Wave 2 service must mask all but last 4 digits on response.
   * Stored as plain string in DB; masking is response-layer responsibility.
   */
  @Prop({ type: String })
  accountNumber?: string;

  @Prop({ type: String })
  ifscCode?: string;

  @Prop({
    type: String,
    enum: ['current', 'savings', 'overdraft', 'cash_credit'],
    required: true,
  })
  accountType: string;

  @Prop({ type: Number, default: 0 })
  openingBalancePaise: number;

  @Prop({ type: Date })
  openingBalanceDate?: Date;

  /** Updated atomically via $inc on every transaction — never read-modify-write */
  @Prop({ type: Number, default: 0 })
  currentBalancePaise: number;

  /** Links to dynamically-created Account sub-account under CoA group 1002 */
  @Prop({ type: String, required: true })
  coaAccountCode: string;

  @Prop({ type: Types.ObjectId, required: true })
  coaAccountId: Types.ObjectId;

  @Prop({ type: Boolean, default: false })
  isDefault: boolean;

  @Prop({ type: String })
  upiId?: string;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const BankAccountSchema = SchemaFactory.createForClass(BankAccount);

BankAccountSchema.index({ firmId: 1, isDefault: 1 });
BankAccountSchema.index({ workspaceId: 1, firmId: 1, isDeleted: 1 });
