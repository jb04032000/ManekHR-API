import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { AppModule } from '../../../common/enums/modules.enum';
import { FeatureAccessLevel } from '../../../common/enums/feature-access.enum';

export type AddOnDefinitionDocument = AddOnDefinition & Document;

export enum AddOnType {
  QUOTA = 'quota',
  MODULE = 'module',
  SUBFEATURE = 'subfeature',
  /**
   * Wave 4 Credit-Pack model.
   *
   * Pre-paid SMS / WhatsApp message credit bundles. Unlike QUOTA add-ons
   * which raise a recurring monthly cap, CREDIT_PACK purchases top up an
   * absolute balance counter on `subscription.appliedEntitlements.communications.*`.
   *
   * Important: CREDIT_PACK deltas are NOT processed by the entitlement-merge
   * recompute (`mergeEntitlements()`). Balance mutates imperatively via
   * `applyCreditPackToBalance()` on purchase activation and `consumeCredit()`
   * on each SMS / WhatsApp send.
   */
  CREDIT_PACK = 'credit_pack',
}

export enum AddOnBillingCycle {
  MONTHLY = 'monthly',
  YEARLY = 'yearly',
  LIFETIME = 'lifetime',
  SUBSCRIPTION = 'subscription',
}

@Schema({ _id: false })
export class CreditsDelta {
  @Prop({ default: 0 }) sms: number;
  @Prop({ default: 0 }) whatsapp: number;
}

@Schema({ _id: false })
export class AddOnEntitlementDelta {
  @Prop({ default: 0 }) extraWorkspaces: number;
  @Prop({ default: 0 }) extraMembersPerWorkspace: number;
  @Prop({ default: 0 }) extraTotalMembers: number;
  @Prop({ default: 0 }) extraSessionsPerPlatform: number;
  @Prop({ default: 0 }) extraSessionsTotal: number;

  @Prop({ type: String, enum: AppModule }) targetModule: AppModule;

  @Prop({ type: String, enum: AppModule }) targetSubFeatureModule: AppModule;
  @Prop() targetSubFeatureKey: string;
  @Prop({ type: String, enum: FeatureAccessLevel })
  targetSubFeatureAccess: FeatureAccessLevel;

  @Prop({ type: Object }) featureOverrides: Record<string, boolean>;

  /**
   * Credit-pack delta — number of SMS / WhatsApp credits granted per unit
   * purchased. On activation, multiplied by `quantity` and $inc'd onto
   * `subscription.appliedEntitlements.communications.{sms,whatsapp}CreditsBalance`.
   * Ignored by `mergeEntitlements()` — see AddOnType.CREDIT_PACK doc.
   */
  @Prop({ type: CreditsDelta }) creditsDelta?: CreditsDelta;
}

@Schema({ timestamps: true })
export class AddOnDefinition extends Document {
  @Prop({ required: true }) name: string;
  @Prop() description: string;
  @Prop({ required: true, index: true }) slug: string;

  @Prop({ required: true, enum: AddOnType, type: String }) type: AddOnType;

  @Prop({ type: AddOnEntitlementDelta, required: true })
  entitlementDelta: AddOnEntitlementDelta;

  @Prop({ required: true, default: 0 }) monthlyPrice: number;
  @Prop({ required: true, default: 0 }) yearlyPrice: number;
  @Prop({ required: true, default: 0 }) lifetimePrice: number;

  @Prop({ default: false }) stackable: boolean;
  @Prop({ default: -1 }) maxStack: number;

  @Prop({ type: [String], default: [] }) applicableTiers: string[];

  @Prop({ default: true }) isActive: boolean;
  @Prop({ default: 0 }) displayOrder: number;

  @Prop({
    required: true,
    enum: AddOnBillingCycle,
    type: String,
    default: AddOnBillingCycle.MONTHLY,
  })
  defaultBillingCycle: AddOnBillingCycle;

  @Prop({
    type: [String],
    default: ['monthly', 'yearly', 'lifetime', 'subscription'],
  })
  allowedBillingCycles: string[];

  @Prop({ default: true }) allowProratedBilling: boolean;

  @Prop({ default: 0 }) minDaysBeforeRenewal: number;
}

export const AddOnDefinitionSchema =
  SchemaFactory.createForClass(AddOnDefinition);
