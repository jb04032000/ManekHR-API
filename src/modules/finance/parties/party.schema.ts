import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Party extends Document {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  firmId: Types.ObjectId;

  @Prop({ type: String, required: true })
  name: string;

  @Prop({
    type: String,
    enum: ['customer', 'vendor', 'broker', 'transporter', 'employee_advance'],
    required: true,
  })
  partyType: string;

  @Prop({ type: Boolean, default: false })
  isInformal: boolean;

  @Prop({ type: String })
  gstin?: string;

  @Prop({ type: String })
  pan?: string;

  @Prop({ type: String })
  state?: string;

  @Prop({ type: Number, default: 30 })
  creditTermsDays: number;

  @Prop({
    type: {
      isUdyamRegistered: { type: Boolean, default: false },
      udyamNumber: { type: String },
      msmeCategory: { type: String, enum: ['micro', 'small', 'medium'] },
      verifiedAt: { type: Date },
    },
    default: { isUdyamRegistered: false },
  })
  msmeRegistration: {
    isUdyamRegistered: boolean;
    udyamNumber?: string;
    msmeCategory?: string;
    verifiedAt?: Date;
  };

  @Prop({
    type: {
      amount: { type: Number },
      type: { type: String, enum: ['debit', 'credit'] },
      asOfDate: { type: Date },
    },
  })
  openingBalance?: { amount: number; type: 'debit' | 'credit'; asOfDate: Date };

  @Prop({
    type: [
      {
        channel: { type: String },
        consented: { type: Boolean },
        timestamp: { type: Date },
        ua: { type: String },
        ip: { type: String },
      },
    ],
    default: [],
  })
  consentLog: {
    channel: string;
    consented: boolean;
    timestamp: Date;
    ua?: string;
    ip?: string;
  }[];

  @Prop({
    type: [
      {
        name: { type: String },
        role: { type: String },
        phone: { type: String },
        email: { type: String },
        birthday: { type: Date },
        anniversary: { type: Date },
        // Phase 17 D-32 — per-contact opt-out from greetings dispatch.
        suppressGreetings: { type: Boolean, default: false },
      },
    ],
    default: [],
  })
  contacts: {
    name: string;
    role: string;
    phone?: string;
    email?: string;
    birthday?: Date;
    anniversary?: Date;
    suppressGreetings?: boolean;
  }[];

  @Prop({ type: String })
  phone?: string;

  @Prop({ type: String })
  email?: string;

  @Prop({ type: String })
  address?: string;

  @Prop({ type: Number })
  brokerCommissionPct?: number;  // default commission pct when partyType === 'broker'

  @Prop({
    type: String,
    enum: ['contractor', 'professional', 'broker', 'transporter', null],
    default: null,
  }) supplierType?: 'contractor' | 'professional' | 'broker' | 'transporter' | null;

  @Prop({
    type: String,
    enum: ['individual_huf', 'company_firm', null],
    default: null,
  }) deducteeStatus?: 'individual_huf' | 'company_firm' | null;

  /** Preferred print locale for voucher PDFs (Phase 16 D-37). Optional — defaults flow to firm.defaultPrintLocale then 'en'. */
  @Prop({ type: String, enum: ['en', 'gu', 'hi'], required: false })
  preferredLocale?: 'en' | 'gu' | 'hi';

  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;

  /**
   * Phase 17 / FIN-16-01..02 — Party Intelligence sub-doc (D-05).
   *
   * CRITICAL (research §Pattern 4): default MUST be `undefined`, never `{}`.
   * Defaulting to {} causes Mongoose to write the empty object back on every
   * save, silently overwriting any concurrent updater's changes.
   *
   * Lazily populated by the nightly RFM cron (Wave-1 Plan 04). Existing
   * parties read `undefined` until the first run touches them.
   */
  @Prop({
    type: {
      rfmR: { type: Number, min: 1, max: 5 },
      rfmF: { type: Number, min: 1, max: 5 },
      rfmM: { type: Number, min: 1, max: 5 },
      segment: {
        type: String,
        enum: ['NEW', 'REGULAR', 'VIP', 'DORMANT', 'CHURNED', 'BLACKLIST'],
      },
      recencyDays: { type: Number },
      frequency: { type: Number },
      monetaryPaise: { type: Number },
      lastInvoiceDate: { type: Date },
      ltv12mPaise: { type: Number },
      txCount12m: { type: Number },
      segmentUpdatedAt: { type: Date },
      manualSegment: {
        type: String,
        enum: ['NEW', 'REGULAR', 'VIP', 'DORMANT', 'CHURNED', 'BLACKLIST', null],
        default: null,
      },
      blacklisted: { type: Boolean, default: false },
      blacklistedReason: { type: String },
      blacklistedAt: { type: Date },
      blacklistedBy: { type: Types.ObjectId, ref: 'User' },
      gstinFilings: {
        type: [
          {
            return: { type: String },
            period: { type: String },
            dueDate: { type: Date },
            filedDate: { type: Date },
            status: { type: String },
          },
        ],
        default: undefined,
      },
      gstinRiskLevel: {
        type: String,
        enum: ['OK', 'WATCH', 'RISK', 'CRITICAL'],
        default: 'OK',
      },
      gstinFilingsCheckedAt: { type: Date },
      gstinFilingsLastError: {
        type: { at: { type: Date }, message: { type: String } },
        default: undefined,
        _id: false,
      },
    },
    default: undefined,
    _id: false,
  })
  intelligence?: {
    rfmR?: number;
    rfmF?: number;
    rfmM?: number;
    segment?:
      | 'NEW'
      | 'REGULAR'
      | 'VIP'
      | 'DORMANT'
      | 'CHURNED'
      | 'BLACKLIST';
    recencyDays?: number;
    frequency?: number;
    monetaryPaise?: number;
    lastInvoiceDate?: Date;
    ltv12mPaise?: number;
    txCount12m?: number;
    segmentUpdatedAt?: Date;
    manualSegment?:
      | 'NEW'
      | 'REGULAR'
      | 'VIP'
      | 'DORMANT'
      | 'CHURNED'
      | 'BLACKLIST'
      | null;
    blacklisted?: boolean;
    blacklistedReason?: string;
    blacklistedAt?: Date;
    blacklistedBy?: Types.ObjectId;
    gstinFilings?: {
      return: string;
      period: string;
      dueDate: Date;
      filedDate?: Date | null;
      status: string;
    }[];
    gstinRiskLevel?: 'OK' | 'WATCH' | 'RISK' | 'CRITICAL';
    gstinFilingsCheckedAt?: Date;
    gstinFilingsLastError?: { at: Date; message: string };
  };
}

export const PartySchema = SchemaFactory.createForClass(Party);
PartySchema.index({ workspaceId: 1, firmId: 1 });
PartySchema.index({ workspaceId: 1, firmId: 1, gstin: 1 }, { sparse: true });
PartySchema.index({ workspaceId: 1, firmId: 1, isDeleted: 1 });
// Phase 17 — segment + GSTIN-risk filters on party list.
PartySchema.index({ workspaceId: 1, firmId: 1, 'intelligence.segment': 1 });
PartySchema.index({ workspaceId: 1, firmId: 1, 'intelligence.gstinRiskLevel': 1 });
