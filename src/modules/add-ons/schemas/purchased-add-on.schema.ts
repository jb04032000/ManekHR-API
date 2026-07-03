import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  AddOnEntitlementDelta,
  AddOnBillingCycle,
} from './add-on-definition.schema';

export type PurchasedAddOnDocument = PurchasedAddOn & Document;

export enum PurchasedAddOnStatus {
  ACTIVE = 'active',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
  SUPERSEDED = 'superseded',
}

export enum PurchasedAddOnSource {
  SELF = 'self',
  ADMIN = 'admin',
}

@Schema({ timestamps: true })
export class PurchasedAddOn extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Subscription', required: true })
  subscriptionId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'AddOnDefinition', required: true })
  addOnDefinitionId: Types.ObjectId;

  @Prop({
    required: true,
    enum: PurchasedAddOnStatus,
    type: String,
    default: PurchasedAddOnStatus.ACTIVE,
  })
  status: PurchasedAddOnStatus;

  @Prop({
    required: true,
    enum: PurchasedAddOnSource,
    type: String,
    default: PurchasedAddOnSource.SELF,
  })
  source: PurchasedAddOnSource;

  @Prop({ type: Types.ObjectId, ref: 'User' }) assignedBy: Types.ObjectId;

  @Prop({ type: AddOnEntitlementDelta, required: true })
  entitlementDelta: AddOnEntitlementDelta;

  @Prop({ required: true, enum: AddOnBillingCycle, type: String })
  billingCycle: AddOnBillingCycle;

  @Prop({ default: 1 }) quantity: number;

  @Prop() activatedAt: Date;
  @Prop() expiresAt: Date;
  @Prop() cancelledAt: Date;

  @Prop({ default: 0 }) proratedAmount: number;

  @Prop() note: string;
}

export const PurchasedAddOnSchema =
  SchemaFactory.createForClass(PurchasedAddOn);

PurchasedAddOnSchema.index({ userId: 1, status: 1 });
PurchasedAddOnSchema.index({ subscriptionId: 1, status: 1 });
PurchasedAddOnSchema.index({ userId: 1, addOnDefinitionId: 1, status: 1 });
