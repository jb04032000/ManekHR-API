import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Firm extends Document {
  // Uniqueness (one Firm per workspace) is enforced by
  // `FirmSchema.index({ workspaceId: 1 }, { unique: true })` near the bottom of
  // this file — do NOT also put `unique`/`index` here. Declaring it both ways made
  // Mongoose warn "Duplicate schema index on {workspaceId:1}". Keep this @Prop and
  // that .index() in sync on merge.
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: String, required: true })
  firmName: string;

  // 'textile' = Surat/Gujarat textile trade/processing preset. Seeds the textile
  // CoA template (fabric stock stages, job-work income/charges split by process,
  // dalali/kasar-vatav/vyaj) via AccountsService.seedFromTemplate -> COA_SEED_MAP.
  // A textile firm is a normal registered taxpayer (not composition).
  @Prop({
    type: String,
    enum: ['trading', 'manufacturing', 'service', 'composition', 'textile'],
    required: true,
  })
  businessType: string;

  @Prop({ type: String })
  gstin?: string;

  // 2f multi-GSTIN: one legal entity (same PAN) can hold a separate GSTIN per
  // state of operation. `gstin` above is the primary registration; this holds
  // the additional state registrations. An invoice picks its seller GSTIN from
  // this set by the supplying branch / state.
  @Prop({
    type: [
      {
        gstin: { type: String, required: true },
        stateCode: { type: String, required: true },
        label: { type: String },
        // Each GST registration is a distinct place of business. tradeName +
        // address let an invoice supplied from this branch print the correct
        // registered name/address for the seller GSTIN it actually uses.
        tradeName: { type: String },
        address: {
          line1: { type: String },
          line2: { type: String },
          city: { type: String },
          state: { type: String },
          pincode: { type: String },
        },
      },
    ],
    default: [],
  })
  additionalGstins: {
    gstin: string;
    stateCode: string;
    label?: string;
    tradeName?: string;
    address?: {
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      pincode?: string;
    };
  }[];

  @Prop({ type: String })
  pan?: string;

  /**
   * Principal place of business - the registered address for the primary GSTIN.
   * Rendered on invoice/voucher headers and used as the default seller address;
   * `stateCode` (2-digit GST code) drives place-of-supply resolution. Before this
   * field existed the print themes referenced a seller address that was never
   * persisted, so invoices printed a blank address. Optional + defaulted so
   * existing firms need no migration.
   */
  @Prop({
    type: {
      line1: { type: String },
      line2: { type: String },
      city: { type: String },
      stateCode: { type: String },
      state: { type: String },
      pincode: { type: String },
      country: { type: String, default: 'India' },
    },
    default: () => ({ country: 'India' }),
  })
  address: {
    line1?: string;
    line2?: string;
    city?: string;
    stateCode?: string;
    state?: string;
    pincode?: string;
    country?: string;
  };

  @Prop({ type: String })
  contactPhone?: string;

  @Prop({ type: String })
  contactEmail?: string;

  @Prop({ type: String })
  website?: string;

  @Prop({ type: Number, default: 4 })
  fyStartMonth: number;

  @Prop({ type: Date })
  accountsBooksBeginDate?: Date;

  // D21 period locking: postings/edits dated ON OR BEFORE this date are blocked (e.g. after a
  // month's GSTR is filed / the CA closes it). Independent of FY close; enforced centrally by
  // FyLockService.assertOpen. Null/unset = no period lock.
  @Prop({ type: Date })
  booksLockedUptoDate?: Date;

  @Prop({ type: Number, default: 0 })
  aato: number;

  @Prop({
    type: String,
    enum: ['moving_average', 'fifo'],
    default: 'moving_average',
  })
  inventoryValuationMethod: string;

  @Prop({ type: Number, default: 18.0 })
  lateFeePct: number;

  @Prop({
    type: String,
    enum: ['half_up', 'round_off_to_rupee'],
    default: 'half_up',
  })
  roundingPolicy: string;

  @Prop({ type: Number, default: 2 })
  qtyDecimalPlaces: number;

  @Prop({
    type: String,
    enum: ['owner', 'manager', 'accountant'],
    default: 'owner',
  })
  primaryRole: string;

  @Prop({
    type: {
      mode: { type: String, enum: ['platform', 'byok'], default: 'platform' },
      encryptedApiKey: { type: String },
      provider: { type: String },
    },
    default: { mode: 'platform' },
  })
  gstinProviderConfig: {
    mode: 'platform' | 'byok';
    encryptedApiKey?: string;
    provider?: string;
  };

  @Prop({ type: Object, default: {} })
  brandProfile: Record<string, any>;

  @Prop({
    type: {
      step1Done: { type: Boolean, default: false },
      step2Done: { type: Boolean, default: false },
      step3Done: { type: Boolean, default: false },
      dismissedFields: { type: [String], default: [] },
    },
    default: { step1Done: false, step2Done: false, step3Done: false, dismissedFields: [] },
  })
  setupChecklistState: {
    step1Done: boolean;
    step2Done: boolean;
    step3Done: boolean;
    dismissedFields: string[];
  };

  @Prop({ type: Boolean, default: false })
  mahuratEnabled: boolean;

  @Prop({
    type: String,
    enum: ['fy_only', 'vs_only', 'both'],
    default: 'both',
  })
  traditionalNewYearMode: string;

  @Prop({
    type: Object,
    default: {
      quotation: false,
      sale_order: false,
      proforma: false,
      delivery_challan: false,
      sale_invoice: false,
      purchase_bill: false,
      payment_out: false,
    },
  })
  makerCheckerEnabled: {
    quotation: boolean;
    sale_order: boolean;
    proforma: boolean;
    delivery_challan: boolean;
    sale_invoice: boolean;
    purchase_bill?: boolean;
    payment_out?: boolean;
  };

  // REMOVED 2026-06-06 (feedback_no_payments_in_billing): the Razorpay/Cashfree
  // payment-gateway credential fields (razorpayKeyId / razorpayKeySecret /
  // razorpayWebhookSecret / cashfreeAppId / cashfreeSecretKey) were dead - the finance
  // module does NO payment collection. They were never read by any payment path. The
  // platform's SaaS subscription gateway is a SEPARATE system (subscriptions/billing,
  // uses its own platform Razorpay key) and is unaffected. Mongoose ignores the leftover
  // values on existing docs (strict mode drops undefined-in-schema fields).

  @Prop({
    type: {
      username: { type: String },
      encryptedPassword: { type: String },
    },
  })
  erpCredentials?: { username: string; encryptedPassword: string };

  @Prop({ type: String })
  erpSessionToken?: string; // ephemeral; mirrored in Redis

  @Prop({ type: Date })
  erpSessionExpiry?: Date;

  /** IRP (e-Invoice) provider config — gspKey/encryptedPassword stored as AES-256 cipher-text (Wave 2 service encrypts) */
  @Prop({
    type: {
      mode: { type: String, enum: ['gsp_surepass', 'nic_direct'], default: 'gsp_surepass' },
      gspKey: { type: String },
      username: { type: String },
      encryptedPassword: { type: String },
    },
    default: () => ({ mode: 'gsp_surepass' }),
  })
  irpConfig: {
    mode: 'gsp_surepass' | 'nic_direct';
    gspKey?: string;
    username?: string;
    encryptedPassword?: string;
  };

  /** EWB (e-Way Bill) provider config — separate from irpConfig so a firm can use SurePass for IRP and NIC for EWB independently */
  @Prop({
    type: {
      mode: { type: String, enum: ['gsp_surepass', 'nic_direct'], default: 'gsp_surepass' },
      gspKey: { type: String },
      username: { type: String },
      encryptedPassword: { type: String },
    },
    default: () => ({ mode: 'gsp_surepass' }),
  })
  ewbConfig: {
    mode: 'gsp_surepass' | 'nic_direct';
    gspKey?: string;
    username?: string;
    encryptedPassword?: string;
  };

  /** QRMP (Quarterly Return Monthly Payment) scheme — affects GSTR-3B period (monthly vs quarterly) */
  @Prop({ type: Boolean, default: false })
  qrmpScheme: boolean;

  /**
   * Per-firm statutory compliance profile (Section 6.F). Firms differ:
   * some perform dyeing/printing job-work (taxed at the 18% residuary rate,
   * not the 5% general-textile rate), some run the composition scheme. These
   * flags select WHICH statutory rules apply to this firm; the effective-dated
   * rate tables stay shared. Pure derivations live in `firm-compliance.ts`
   * (Phase 2 consumers); `aato` (in lakhs) drives the turnover-band rules.
   *
   * `compositionScheme` mirrors `businessType === 'composition'` for an
   * explicit, queryable flag independent of the coarse business-type enum.
   * `itc04FrequencyOverride` lets a firm pin ITC-04 cadence when the default
   * turnover-band heuristic does not match its actual filing obligation.
   */
  @Prop({
    type: {
      doesDyeingPrinting: { type: Boolean, default: false },
      defaultJobWorkType: {
        type: String,
        enum: ['general_textile', 'dyeing_printing', 'other'],
        default: 'general_textile',
      },
      compositionScheme: { type: Boolean, default: false },
      itc04FrequencyOverride: {
        type: String,
        enum: ['half_yearly', 'annual'],
        required: false,
      },
    },
    default: () => ({
      doesDyeingPrinting: false,
      defaultJobWorkType: 'general_textile',
      compositionScheme: false,
    }),
  })
  compliance: {
    doesDyeingPrinting: boolean;
    defaultJobWorkType: 'general_textile' | 'dyeing_printing' | 'other';
    compositionScheme: boolean;
    itc04FrequencyOverride?: 'half_yearly' | 'annual';
  };

  /**
   * Per-firm invoice layout config (design spec 2026-06-01 SS2C / 3B).
   * Five show/hide flags for A4 web print themes. All default to true so a
   * firm without a stored value renders identically to today. The web themes
   * use `layout?.<flag> !== false` at every draw site (undefined and true
   * both render; only an explicit false hides the section). Persisted as a
   * nested object with individual `default: true` sub-fields so Mongoose
   * populates each flag for new firms automatically.
   */
  @Prop({
    type: {
      showHsnColumn: { type: Boolean, default: true },
      showDiscountColumn: { type: Boolean, default: true },
      showBankDetails: { type: Boolean, default: true },
      showSignature: { type: Boolean, default: true },
      showTermsAndConditions: { type: Boolean, default: true },
    },
    default: () => ({
      showHsnColumn: true,
      showDiscountColumn: true,
      showBankDetails: true,
      showSignature: true,
      showTermsAndConditions: true,
    }),
  })
  invoiceLayout: {
    showHsnColumn: boolean;
    showDiscountColumn: boolean;
    showBankDetails: boolean;
    showSignature: boolean;
    showTermsAndConditions: boolean;
  };

  /** Allow inventory to go negative when issuing materials (D-19, T-F10-W4-01) */
  @Prop({ type: Boolean, default: false })
  allowNegativeStock: boolean;

  /** Default print locale for voucher PDFs (Phase 16 D-37). Falls through to 'en' on miss. */
  @Prop({ type: String, enum: ['en', 'gu', 'hi'], default: 'en' })
  defaultPrintLocale: 'en' | 'gu' | 'hi';

  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const FirmSchema = SchemaFactory.createForClass(Firm);
// SINGLE source of the {workspaceId:1} unique index — the workspaceId @Prop above
// intentionally omits `unique` so this is the only declaration (no dup warning).
// The compound index below is a different key and is unaffected.
FirmSchema.index({ workspaceId: 1 }, { unique: true });
FirmSchema.index({ workspaceId: 1, isDeleted: 1 });
