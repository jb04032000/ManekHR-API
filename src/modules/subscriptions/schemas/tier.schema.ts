import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ _id: false })
export class TierDefaultEntitlements {
  @Prop({ default: 1 }) maxWorkspaces: number;
  @Prop({ default: 5 }) maxMembersPerWorkspace: number;
  @Prop({ default: 5 }) maxTotalMembers: number;
}

@Schema({ _id: false })
export class TierSubFeatureAccess {
  @Prop({ required: true }) key: string;
  @Prop({
    required: true,
    default: 'full',
    enum: ['locked', 'limited', 'full'],
  })
  access: string;
}

@Schema({ _id: false })
export class TierDefaultModuleAccess {
  @Prop({ required: true }) module: string;
  @Prop({ required: true, default: false }) enabled: boolean;
  @Prop({ type: [TierSubFeatureAccess], default: [] })
  subFeatures: TierSubFeatureAccess[];
}

@Schema({ timestamps: true })
export class Tier extends Document {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ required: true, default: 0 })
  displayOrder: number;

  @Prop({ required: true, default: 'default' })
  color: string;

  @Prop()
  description?: string;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ type: TierDefaultEntitlements, default: () => ({}) })
  defaultEntitlements: TierDefaultEntitlements;

  @Prop({ type: [TierDefaultModuleAccess], default: [] })
  defaultModuleAccess: TierDefaultModuleAccess[];

  /**
   * Which product line this tier belongs to:
   *   erp     = ERP workspace tier (default; existing behavior unchanged)
   *   connect = person-centric Connect tier (network / marketplace)
   *   bundle  = combined ERP + Connect
   * Mirrors `Plan.product`. Lets tier listings scope per product line.
   */
  @Prop({ type: String, enum: ['erp', 'connect', 'bundle'], default: 'erp', index: true })
  product: string;
}

export const TierSchema = SchemaFactory.createForClass(Tier);
