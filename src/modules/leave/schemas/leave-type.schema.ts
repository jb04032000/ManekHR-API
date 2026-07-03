import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * Per-locale display labels for a leave type. `en` is canonical + required;
 * `gu-en` / `hi-en` / `gu` are optional (UI falls back to `en`). Mirrors the
 * workspace designation label model.
 */
export interface LeaveTypeLabels {
  en: string;
  'gu-en'?: string;
  'hi-en'?: string;
  gu?: string;
}

export type LeaveTypeUnit = 'full_day' | 'half_day_capable';
export type LeaveStatutoryBasis = 'factories_act' | 'shops_act' | 'maternity_act' | 'voluntary';
export type LeaveAccrualMode = 'upfront_annual' | 'periodic_accrual' | 'none';
export type LeaveAccrualFrequency = 'monthly' | 'quarterly' | 'annual';
export type LeaveGenderApplicability = 'male' | 'female' | 'any';

/**
 * LeaveType — a workspace's configurable leave-catalogue entry. Seeded with an
 * India SMB preset on workspace creation; the owner edits/extends it later.
 *
 * `accrualRule` / `yearEndRule` / `compOff` are consumed by the L2 accrual
 * engine — L1 only persists them. `isSystem` types (LWP) are non-deletable.
 */
@Schema({ timestamps: true, collection: 'leavetypes' })
export class LeaveType extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  /** Short uppercase code, unique per workspace (e.g. CL, SL, EL, COMP, LWP). */
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code: string;

  @Prop({
    type: {
      en: { type: String, required: true },
      'gu-en': { type: String, default: null },
      'hi-en': { type: String, default: null },
      gu: { type: String, default: null },
    },
    required: true,
    _id: false,
  })
  labels: LeaveTypeLabels;

  @Prop({ type: String, default: '#1677ff' })
  color: string;

  /** Paid leave does not dock pay; unpaid (LWP) leave is a salary deduction. */
  @Prop({ type: Boolean, default: true })
  isPaid: boolean;

  @Prop({
    type: String,
    enum: ['full_day', 'half_day_capable'],
    default: 'half_day_capable',
  })
  unit: LeaveTypeUnit;

  @Prop({
    type: String,
    enum: ['factories_act', 'shops_act', 'maternity_act', 'voluntary'],
    default: 'voluntary',
  })
  statutoryBasis: LeaveStatutoryBasis;

  /** Cap on one request's day count (Maternity 182 / Paternity 5 …). null = unbounded. */
  @Prop({ type: Number, default: null })
  maxPerRequest: number | null;

  @Prop({
    type: {
      gender: { type: String, enum: ['male', 'female', 'any'], default: 'any' },
      minTenureDays: { type: Number, default: null },
      designationIds: { type: [Types.ObjectId], default: [] },
    },
    default: () => ({ gender: 'any', minTenureDays: null, designationIds: [] }),
    _id: false,
  })
  applicability: {
    gender: LeaveGenderApplicability;
    minTenureDays: number | null;
    designationIds: Types.ObjectId[];
  };

  @Prop({
    type: {
      mode: {
        type: String,
        enum: ['upfront_annual', 'periodic_accrual', 'none'],
        default: 'none',
      },
      annualQuantity: { type: Number, default: 0 },
      rate: { type: Number, default: null },
      frequency: {
        type: String,
        enum: ['monthly', 'quarterly', 'annual', null],
        default: null,
      },
      proRateFirstPeriod: { type: Boolean, default: true },
      accrualCap: { type: Number, default: null },
      eligibleAfterDays: { type: Number, default: 0 },
    },
    default: () => ({
      mode: 'none',
      annualQuantity: 0,
      rate: null,
      frequency: null,
      proRateFirstPeriod: true,
      accrualCap: null,
      eligibleAfterDays: 0,
    }),
    _id: false,
  })
  accrualRule: {
    mode: LeaveAccrualMode;
    annualQuantity: number;
    rate: number | null;
    frequency: LeaveAccrualFrequency | null;
    proRateFirstPeriod: boolean;
    accrualCap: number | null;
    eligibleAfterDays: number;
  };

  @Prop({
    type: {
      carryForwardCap: { type: Number, default: 0 },
      lapseExcess: { type: Boolean, default: true },
      encashable: { type: Boolean, default: false },
      encashmentCap: { type: Number, default: null },
    },
    default: () => ({
      carryForwardCap: 0,
      lapseExcess: true,
      encashable: false,
      encashmentCap: null,
    }),
    _id: false,
  })
  yearEndRule: {
    carryForwardCap: number;
    lapseExcess: boolean;
    encashable: boolean;
    encashmentCap: number | null;
  };

  @Prop({
    type: {
      isCompOff: { type: Boolean, default: false },
      validityDays: { type: Number, default: 90 },
    },
    default: () => ({ isCompOff: false, validityDays: 90 }),
    _id: false,
  })
  compOff: { isCompOff: boolean; validityDays: number };

  /** System types (LWP) are non-deletable; the owner may still relabel them. */
  @Prop({ type: Boolean, default: false })
  isSystem: boolean;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Number, default: 0 })
  sortOrder: number;

  /** Null for system-seeded types; set to the owner/HR user for hand-created types. */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  createdBy: Types.ObjectId | null;
}

export const LeaveTypeSchema = SchemaFactory.createForClass(LeaveType);

// One catalogue entry per code per workspace.
LeaveTypeSchema.index({ workspaceId: 1, code: 1 }, { unique: true });
// Active-types listing for a workspace.
LeaveTypeSchema.index({ workspaceId: 1, isActive: 1 });
