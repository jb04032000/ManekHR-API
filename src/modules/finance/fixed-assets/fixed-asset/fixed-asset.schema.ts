import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

interface FixedAssetAuditEntry {
  at: Date;
  by: Types.ObjectId;
  action: string;
  before?: Record<string, any>;
  after?: Record<string, any>;
  reason?: string;
}

@Schema({ timestamps: true })
export class FixedAsset extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true }) workspaceId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true, index: true }) firmId: Types.ObjectId;
  @Prop({ type: String, required: true, index: true }) assetCode: string;
  @Prop({ type: String, required: true, trim: true }) name: string;
  @Prop({ type: String, trim: true }) description?: string;
  @Prop({ type: Types.ObjectId, required: true }) categoryId: Types.ObjectId;
  @Prop({ type: Object }) categorySnapshot?: Record<string, any>;
  @Prop({ type: String, required: true }) financialYear: string;
  @Prop({ type: Date, required: true }) purchaseDate: Date;
  @Prop({ type: Date }) installationDate?: Date;
  @Prop({ type: Types.ObjectId }) purchaseBillId?: Types.ObjectId;
  @Prop({ type: String }) purchaseBillNumber?: string;
  @Prop({ type: Types.ObjectId }) partyId?: Types.ObjectId;
  @Prop({ type: String }) partyName?: string;
  @Prop({ type: Number, required: true }) costPaise: number;
  @Prop({ type: Number, required: true }) salvageValuePaise: number;
  @Prop({ type: Number, required: true }) depreciableAmountPaise: number;
  @Prop({ type: Number, required: true }) usefulLifeYears: number;
  @Prop({ type: String, enum: ['slm', 'wdv'], required: true }) depreciationMethod: string;
  @Prop({ type: Number }) slmRateOverride?: number;
  @Prop({ type: Number }) wdvRateOverride?: number;
  @Prop({ type: String, enum: ['monthly', 'quarterly'], default: 'monthly' }) depreciationFrequency: string;
  @Prop({ type: String, enum: ['single', 'double', 'triple'], default: 'single' }) shiftType: string;
  @Prop({ type: Number, required: true }) openingNbvPaise: number;
  @Prop({ type: Number, default: 0 }) accumulatedDepreciationPaise: number;
  @Prop({ type: Number, required: true }) nbvPaise: number;
  @Prop({ type: String }) lastDepreciationMonth?: string;
  @Prop({ type: String, index: true }) nextDepreciationMonth?: string;
  @Prop({ type: Types.ObjectId }) locationId?: Types.ObjectId;
  @Prop({ type: Types.ObjectId }) custodianMemberId?: Types.ObjectId;
  @Prop({ type: String }) serialNumber?: string;
  @Prop({ type: String }) qrCodeData?: string;
  @Prop({ type: Date }) lastVerifiedAt?: Date;
  @Prop({ type: Types.ObjectId }) lastVerifiedBy?: Types.ObjectId;
  @Prop({ type: Types.ObjectId }) itcScheduleId?: Types.ObjectId;
  @Prop({ type: Number, default: 0 }) itcClaimedPaise: number;
  @Prop({ type: Types.ObjectId }) machineId?: Types.ObjectId;
  @Prop({ type: [String], default: [] }) tags: string[];
  @Prop({ type: String }) notes?: string;
  @Prop({
    type: String,
    enum: ['active', 'disposed', 'scrapped', 'transferred'],
    default: 'active',
    index: true,
  }) status: string;
  @Prop({ type: Date }) disposalDate?: Date;
  @Prop({ type: Number, default: 0 }) disposalProceedsPaise: number;
  @Prop({ type: Number, default: 0 }) gainLossOnDisposalPaise: number;
  @Prop({ type: Types.ObjectId }) disposalVoucherId?: Types.ObjectId;
  @Prop({ type: String }) disposalNarration?: string;
  @Prop({ type: Boolean, default: false }) isFullyDepreciated: boolean;
  @Prop({ type: Boolean, default: false, index: true }) isDeleted: boolean;
  @Prop({ type: Date }) deletedAt?: Date;
  @Prop({ type: Types.ObjectId, required: true }) createdBy: Types.ObjectId;
  @Prop({ type: Types.ObjectId }) updatedBy?: Types.ObjectId;
  @Prop({ type: Array, default: [] }) auditLog: FixedAssetAuditEntry[];
}

export const FixedAssetSchema = SchemaFactory.createForClass(FixedAsset);
FixedAssetSchema.index({ workspaceId: 1, firmId: 1, assetCode: 1 }, { unique: true });
FixedAssetSchema.index({ firmId: 1, status: 1 });
FixedAssetSchema.index({ firmId: 1, categoryId: 1 });
FixedAssetSchema.index({ firmId: 1, financialYear: 1, status: 1 });
FixedAssetSchema.index({ firmId: 1, status: 1, isFullyDepreciated: 1, nextDepreciationMonth: 1 });
