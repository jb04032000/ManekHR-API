import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Workspace } from '../../workspaces/schemas/workspace.schema';
import { Role } from '../../rbac/schemas/role.schema';
import { User } from '../../users/schemas/user.schema';
import { SALARY_TYPES, SalaryType } from '../../salary/constants/salary-types';
import { PieceRateConfig, PieceRateConfigSchema } from './piece-rate-config.schema';

@Schema({ _id: false })
export class Schedule {
  @Prop({ type: String }) startTime: string;
  @Prop({ type: String }) endTime: string;
}

@Schema({ _id: false })
export class BankDetails {
  @Prop({ type: String }) bankName: string;
  @Prop({ type: String }) accountHolderName: string;
  @Prop({ type: String }) accountNumber: string;
  @Prop({ type: String }) ifscCode: string;
  @Prop({ type: String }) passbookImageUrl: string;
}

@Schema({ _id: false })
export class UpiDetails {
  @Prop({ type: String }) upiId: string;
  @Prop({ type: String }) qrCodeUrl: string;
}

@Schema({ _id: false, timestamps: false })
export class BiometricBinding {
  @Prop({ type: String, required: true }) deviceSerial: string;
  @Prop({ type: String, required: true }) deviceUserId: string;
  @Prop({ type: Date, default: Date.now }) addedAt: Date;
  @Prop({ type: Types.ObjectId, ref: 'User' }) addedBy: Types.ObjectId;
}

@Schema({ timestamps: true })
export class TeamMember extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Workspace | Types.ObjectId;

  @Prop({ required: true }) name: string;
  @Prop() mobile: string;
  @Prop() email?: string;
  @Prop() designation?: string;
  @Prop() avatar?: string;

  @Prop({ type: Types.ObjectId, ref: 'Role' })
  rbacRoleId?: Role | Types.ObjectId;

  @Prop({ default: false }) hasAppAccess: boolean;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  linkedUserId?: User | Types.ObjectId;

  // ── DEPRECATED (Wave 2 invite consolidation, 2026-05-10) ───────────────
  // Token storage migrated to WorkspaceMember.inviteToken / .inviteTokenHash
  // / .inviteExpiry. Existing data still readable for one release; new
  // writes go to the bridge schema. Removed in a follow-up cleanup wave
  // once production data is migrated.
  @Prop() appAccessInviteToken?: string;
  @Prop() appAccessInviteTokenHash?: string;
  @Prop() appAccessInviteExpiry?: Date;
  @Prop() appAccessGrantedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  appAccessGrantedBy?: User | Types.ObjectId;

  // ── Wave 2 invite consolidation (2026-05-10) ───────────────────────────
  // Back-reference to the canonical WorkspaceMember row that grants this
  // employee app access. Convenience field for joins (TeamMember →
  // WorkspaceMember → Role) without reverse-querying by linkedTeamMemberId.
  // Population guidance: use Mongoose populate when you need the role; raw
  // ObjectId is enough for permission checks via RolesGuard.
  @Prop({ type: Types.ObjectId, ref: 'WorkspaceMember', default: null })
  linkedWorkspaceMemberId?: Types.ObjectId | null;

  // Per-member permission overrides on top of the assigned RBAC role
  // (App Access Management — P3). Each row force-allows or force-denies a
  // (module, action) tuple, with optional scope ('self' | 'all') for
  // scope-aware actions. RolesGuard merges these via
  // `applyPermissionOverrides` — deny-override beats role-allow; allow-
  // override extends the role.
  @Prop({
    type: [
      {
        module: { type: String, required: true },
        action: { type: String, required: true },
        allowed: { type: Boolean, required: true },
        scope: { type: String, enum: ['self', 'all'], required: false },
      },
    ],
    default: [],
    _id: false,
  })
  permissionOverrides: Array<{
    module: string;
    action: string;
    allowed: boolean;
    scope?: 'self' | 'all';
  }>;

  // Phase 1c — per-member overrides as registry permission PATHS (Team
  // module). The flat `permissionOverrides` above stays for non-path-
  // classified modules. RolesGuard merges these via `applyPathOverrides`:
  // allowed:false force-denies a path, allowed:true force-allows it.
  @Prop({
    type: [
      {
        path: { type: String, required: true },
        allowed: { type: Boolean, required: true },
        scope: { type: String, enum: ['self', 'all'], required: false },
      },
    ],
    default: [],
    _id: false,
  })
  permissionPathOverrides: Array<{
    path: string;
    allowed: boolean;
    scope?: 'self' | 'all';
  }>;

  // Legacy fields kept for backward compatibility
  @Prop() department?: string;
  // `location` holds the denormalised location NAME (legacy free-text + ID card).
  // `locationId` references the workspace Locations master list (same entity the
  // Machines module uses), so employees and machines share one location source.
  @Prop() location?: string;
  @Prop({ type: Types.ObjectId, ref: 'Location' })
  locationId?: Types.ObjectId;
  @Prop() workingDays?: number;
  @Prop() dailyHours?: number;

  @Prop({ type: Types.ObjectId, ref: 'Shift' })
  shiftId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'TeamMember', default: null })
  reportsTo?: Types.ObjectId | null;

  @Prop({ type: [String], default: [] })
  weeklyOff: string[];

  @Prop({ enum: ['shift', 'custom'], default: 'shift' })
  scheduleType: string;

  @Prop({ type: Schedule })
  customSchedule?: Schedule;

  @Prop({ type: String, enum: SALARY_TYPES, default: 'monthly' })
  salaryType: SalaryType;

  @Prop({ default: 0 })
  salaryAmount: number;

  // Phase 23 (D-02): piece-rate config sub-doc.
  // Required when salaryType === 'piece_rate' (validated in TeamService).
  // MUST use `default: undefined` (NOT `{}`) to avoid silent overwrite bug
  // (RESEARCH §2 line 325 + STATE.md F-16-01).
  @Prop({ type: PieceRateConfigSchema, default: undefined })
  pieceRateConfig?: PieceRateConfig;

  @Prop({
    enum: ['fixed_month_days', 'calendar_month_days'],
    default: 'fixed_month_days',
  })
  salaryDayBasis?: string;

  @Prop({ type: Number })
  fixedMonthDays?: number;

  @Prop({
    enum: ['default', 'enabled', 'disabled'],
    default: 'default',
  })
  attendancePayMode?: string;

  @Prop()
  finalMonthlyOverride?: number;

  @Prop({ type: Number })
  ctcAmount?: number;

  @Prop({ type: Types.ObjectId, ref: 'SalaryComponentTemplate' })
  componentTemplateId?: Types.ObjectId;

  @Prop({
    type: [
      {
        componentId: { type: String, required: true },
        calcMode: {
          type: String,
          enum: ['fixed', 'percent_of_ctc', 'percent_of_component'],
        },
        value: { type: Number },
        _id: false,
      },
    ],
    default: [],
  })
  componentOverrides: {
    componentId: string;
    calcMode?: string;
    value?: number;
  }[];

  // Statutory & Tax Compliance Fields
  @Prop({ trim: true })
  pan?: string;

  @Prop({ trim: true })
  uan?: string;

  @Prop({ enum: ['old', 'new'], default: 'new' })
  taxRegime?: string;

  @Prop({ trim: true })
  stateOfEmployment?: string;

  @Prop({
    enum: ['full_time', 'part_time', 'contract', 'intern', 'consultant'],
    default: 'full_time',
  })
  employmentType?: string;

  @Prop({ default: true })
  pfApplicable?: boolean;

  @Prop({ default: false })
  pfOptedOut?: boolean;

  @Prop({ default: false })
  esiApplicable?: boolean;

  @Prop({ trim: true })
  esiIpNumber?: string;

  @Prop({ enum: ['single', 'married', 'divorced', 'widowed'] })
  maritalStatus?: string;

  @Prop({ default: false })
  isNonItrFiler?: boolean;
  // Section 206AB: if true, TDS deducted at 20% flat rate
  // regardless of normal slab computation
  // Admin marks this manually — no API available to verify ITR status

  @Prop({ type: BankDetails }) bankDetails?: BankDetails;
  @Prop({ type: UpiDetails }) upiDetails?: UpiDetails;
  @Prop({ enum: ['BANK', 'UPI', 'CASH'] }) preferredMethod?: string;

  // First-class statutory identity (P2)
  @Prop({ trim: true }) aadhaar?: string;
  @Prop() aadhaarImageUrl?: string;
  @Prop({ trim: true }) fatherOrSpouseName?: string;
  @Prop({ default: 'Indian' }) nationality?: string;

  // Employee code (P3) — system-generated, immutable, and non-replaceable.
  // `immutable: true` blocks any update path from mutating it (Update DTO omits
  // it and create always overwrites client input); uniqueness scoped by
  // (workspaceId, employeeCode) via the partial index below. Includes the
  // workspace code as the {WS} token (renderEmployeeCode in team.service).
  @Prop({
    trim: true,
    maxlength: 32,
    immutable: true,
    match: [
      /^[A-Za-z0-9_-]{1,32}$/,
      'Employee code may only contain letters, digits, hyphens, and underscores (max 32 chars)',
    ],
  })
  employeeCode?: string;

  @Prop({ type: [BiometricBinding], default: [] })
  biometricBindings: BiometricBinding[];

  @Prop() dateOfBirth?: Date;
  @Prop() dateOfJoining?: Date;
  @Prop() dateOfResignation?: Date;
  @Prop() resignationNote?: string;
  @Prop({ enum: ['male', 'female', 'other'] }) gender?: string;
  @Prop() bloodGroup?: string;
  @Prop() emergencyContactName?: string;
  @Prop() emergencyContactNumber?: string;
  @Prop() address?: string;

  @Prop({ default: true }) isActive: boolean;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy: User | Types.ObjectId;

  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date, default: null })
  deletedAt: Date;

  @Prop({ type: Boolean, default: false, index: true })
  isPermanentlyDeleted: boolean;

  @Prop({ type: Date, default: null })
  permanentlyDeletedAt: Date;

  // ── Karigar profile (F-11 D-06) ──────────────────────────────────────────
  /** F-11 D-06: marks team member as a karigar (embroidery worker) */
  @Prop({ type: Boolean, default: false })
  isKarigar: boolean;

  /** F-11 D-06: skill specialization for karigar */
  @Prop({
    type: String,
    enum: ['zari', 'embroidery', 'print', 'dyeing', 'cutting', 'finishing', 'other'],
  })
  karigarSkillType?: string;

  /** F-11 D-06: daily wage in paise — snapshotted into KarigarLinkage at post time */
  @Prop({ type: Number, min: 0 })
  karigarDailyRatePaise?: number;

  // ── Mobile number OTP verification (Phase 1f.1) ──────────────────────────
  // Optional: HR can verify a typed mobile belongs to the employee via SMS-OTP
  // before adding them. Null when verification was skipped at add-time.
  @Prop({ type: Date, default: null })
  mobileVerifiedAt?: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  mobileVerifiedBy?: Types.ObjectId | null;

  // ── Compliance: per-member minimum-wage override (Phase 1 advance-loan) ──
  // Resolution order: this field > PayrollConfig.compliance.minimumWageMonthly
  // > null (guard skipped with MIN_WAGE_UNCONFIGURED warning).
  // HR and Owner only at write time (enforced by team update endpoint).
  @Prop({ type: Number, default: null })
  minimumWageMonthlyOverride?: number | null;

  // ── Kiosk PIN (M-02) ─────────────────────────────────────────────────────
  @Prop({ type: String, default: null })
  kioskPinHash: string | null;

  @Prop({ type: Date, default: null })
  kioskPinSetAt: Date | null;

  @Prop({ type: Number, default: 0 })
  kioskFailedAttempts: number;

  @Prop({ type: Date, default: null })
  kioskLockedUntil: Date | null;
}

export const TeamMemberSchema = SchemaFactory.createForClass(TeamMember);

// F-11 D-06: sparse index for karigar filter on team list
TeamMemberSchema.index(
  { workspaceId: 1, isKarigar: 1 },
  { partialFilterExpression: { isKarigar: true } },
);

// Salary paginated list: workspace + active + name search
TeamMemberSchema.index({ workspaceId: 1, isActive: 1, isDeleted: 1, name: 1 });

// ── Uniqueness indexes ────────────────────────────────────────────────────
// partialFilterExpression ensures:
//   1. Only non-archived members are checked (soft-deleted records don't block new entries).
//   2. Only documents where the field actually exists are indexed (sparse-like behaviour).
// MIGRATION WARNING: If existing data has duplicates, the server will fail to start.
// Run a pre-migration scan to detect and resolve dupes before deploying to production.
TeamMemberSchema.index(
  { workspaceId: 1, mobile: 1 },
  {
    unique: true,
    partialFilterExpression: { mobile: { $type: 'string' }, isDeleted: false },
  },
);
TeamMemberSchema.index(
  { workspaceId: 1, email: 1 },
  {
    unique: true,
    partialFilterExpression: { email: { $type: 'string' }, isDeleted: false },
  },
);
TeamMemberSchema.index(
  { workspaceId: 1, pan: 1 },
  {
    unique: true,
    partialFilterExpression: { pan: { $type: 'string' }, isDeleted: false },
  },
);
TeamMemberSchema.index(
  { workspaceId: 1, aadhaar: 1 },
  {
    unique: true,
    partialFilterExpression: {
      aadhaar: { $type: 'string' },
      isDeleted: false,
    },
  },
);
TeamMemberSchema.index(
  { workspaceId: 1, employeeCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      employeeCode: { $type: 'string' },
      isDeleted: false,
    },
  },
);

// MIGRATION WARNING: If two live (isDeleted:false) members already share the same
// (workspaceId, deviceSerial, deviceUserId) tuple, Mongoose will fail to build this
// index on app startup and the server will not start. Run the detection aggregate in
// H3-02-MIGRATION-NOTES.md BEFORE deploying to production and resolve all duplicates.
// (H2-BUG-AUDIT Phase B row 4 — GAP-1.1-B)
// Biometric binding uniqueness — prevents two live members claiming the same
// (deviceSerial, deviceUserId). Partial filter skips soft-deleted members so
// offboarded bindings do not block a new active member from claiming the same
// device user id. (H2-BUG-AUDIT Phase B row 4 — GAP-1.1-B)
TeamMemberSchema.index(
  {
    workspaceId: 1,
    'biometricBindings.deviceSerial': 1,
    'biometricBindings.deviceUserId': 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
      'biometricBindings.deviceSerial': { $type: 'string' },
      'biometricBindings.deviceUserId': { $type: 'string' },
    },
    background: true,
  },
);
