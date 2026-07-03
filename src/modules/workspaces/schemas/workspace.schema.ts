import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../users/schemas/user.schema';

@Schema({ timestamps: true })
export class Workspace extends Document {
  @Prop({ required: true })
  name: string;

  // Immutable, system-generated short workspace code (e.g. "ZARI"). Embedded
  // as the {WS} token in every employee code so each code names its workspace.
  // Single source of truth — never user-editable. Generated in
  // workspaces.service.create (new) / team.service.ensureWorkspaceCode (legacy),
  // globally unique (suffixed on collision). See workspace-code.util.ts.
  @Prop({ trim: true, uppercase: true, immutable: true })
  workspaceCode?: string;

  @Prop()
  businessType?: string;

  @Prop()
  location?: string;

  // Company postal address — shown on the employee ID card (single source of
  // truth; distinct from the free-text `location` city field). Owner-editable
  // via workspace settings.
  @Prop()
  address?: string;

  @Prop({ default: 'Asia/Kolkata' })
  timezone: string;

  @Prop({ default: 4 })
  fiscalYearStartMonth?: number;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: User | Types.ObjectId;

  @Prop({ default: true })
  isActive: boolean;

  // Designations — phased migration from `string[]` to per-locale records.
  // Field is typed as Mixed in mongoose (`{ type: Array }`) so legacy docs with
  // `string[]` keep loading. The service layer normalises reads via
  // `normalizeDesignationsForRead` (constants/designations.ts) and writes always
  // emit `DesignationRecord[]` going forward. Mobile-app contract preserved by
  // copying `record.canonical` into `team_member.designation` on member writes.
  @Prop({ type: Array, default: [] })
  designations: unknown[];

  @Prop({
    type: [
      {
        id: String,
        label: String,
      },
    ],
    default: [],
  })
  bankAccounts: Record<string, unknown>[];

  @Prop({
    type: {
      logo: String,
      pdfHeaderLogo: String,
      pdfWatermarkLogo: String,
      pdfFooterDetails: String,
      // Owner-uploaded background image, rendered as a light watermark on every
      // employee ID card (generateIdCardPdf). Distinct from pdfWatermarkLogo
      // (report watermark) so ID cards can use a full-bleed background.
      idCardBackground: String,
    },
    default: undefined,
    _id: false,
  })
  branding?: {
    logo?: string;
    pdfHeaderLogo?: string;
    pdfWatermarkLogo?: string;
    pdfFooterDetails?: string;
    idCardBackground?: string;
  };

  @Prop({
    type: {
      includeHeaderLogo: { type: Boolean, default: true },
      includeFooter: { type: Boolean, default: true },
      includeWatermark: { type: Boolean, default: true },
    },
    default: undefined,
    _id: false,
  })
  exportPreferences?: {
    includeHeaderLogo: boolean;
    includeFooter: boolean;
    includeWatermark: boolean;
  };

  @Prop({
    type: {
      enabled: { type: Boolean, default: false },
      format: { type: String, default: '{PREFIX}-{YYYY}-{####}' },
      prefix: { type: String, default: 'EMP' },
      startingNumber: { type: Number, default: 1 },
      allowCustom: { type: Boolean, default: true },
    },
    default: undefined,
    _id: false,
  })
  employeeCodeSettings?: {
    enabled: boolean;
    format: string;
    prefix: string;
    startingNumber: number;
    allowCustom: boolean;
  };

  @Prop({
    type: {
      emailLimitOverride: { type: Number, default: null },
      smtpConfig: {
        host: String,
        port: Number,
        user: String,
        // Workspaces hardening OQ-W8 (Bucket C — credential, no retention basis).
        // `select: false` so the encrypted SMTP password is excluded from EVERY
        // query by default — a generic `findById` / `.lean()` read never carries
        // it, and no API response can echo it back. The two functional readers
        // that genuinely need the value re-include it explicitly with
        // `.select('+emailConfig.smtpConfig.pass')`: the payslip-over-SMTP send
        // (salary.service) and the admin SMTP test/config-read (admin.service).
        // Stored value is already AES-encrypted at rest (encryptSmtpPassword);
        // this default-exclude is defense-in-depth against accidental leakage.
        pass: { type: String, select: false },
        fromEmail: String,
        fromName: String,
        secure: { type: Boolean, default: true },
        enabled: { type: Boolean, default: false },
      },
      usage: {
        count: { type: Number, default: 0 },
        monthKey: String,
      },
    },
    default: undefined,
    _id: false,
  })
  emailConfig?: {
    emailLimitOverride?: number | null;
    smtpConfig?: {
      host?: string;
      port?: number;
      user?: string;
      pass?: string;
      fromEmail?: string;
      fromName?: string;
      secure?: boolean;
      enabled?: boolean;
    };
    usage?: { count: number; monthKey: string };
  };

  @Prop({
    type: {
      approvalLevels: { type: Number, default: 1, min: 1, max: 3 },
      fallbackApprover: { type: Types.ObjectId, ref: 'User', default: null },
      maxDaysBack: { type: Number, default: 30, min: 1, max: 90 },
      maxAttachmentsPerRequest: { type: Number, default: 3, min: 0, max: 10 },
    },
    default: undefined,
    _id: false,
  })
  regularizationConfig?: {
    approvalLevels: number;
    fallbackApprover?: Types.ObjectId | null;
    maxDaysBack: number;
    maxAttachmentsPerRequest: number;
  };

  // ── Access Control Initiative §8 — employee self-service policy ──────────
  // Owner toggles, AND-gated with the role's `self`-scoped permission.
  // Default ON since 2026-07-03 (owner directive): the Employee baseline role
  // grants self punch/leave-apply, so the policy no longer blocks it out of
  // the box; owners can still switch it off per workspace. Existing
  // workspaces were flipped on by migration 0057. Consumers keep the
  // `?? false` fallback for docs that somehow lack the subdoc.
  @Prop({
    type: {
      selfPunch: { type: Boolean, default: true },
      selfLeaveApply: { type: Boolean, default: true },
    },
    default: () => ({ selfPunch: true, selfLeaveApply: true }),
    _id: false,
  })
  selfServiceConfig?: {
    selfPunch: boolean;
    selfLeaveApply: boolean;
  };

  // ── Attendance-module workspace preferences ──────────────────────────────
  // Single namespace for attendance-level prefs that aren't tied to a policy
  // doc. Currently hosts the compliance threshold (defaulters cutoff %) used
  // by the Compliance report UI. Shared across all managers in the workspace
  // — any manager with workspaces.EDIT can change it for everyone. Range
  // mirrors the FE slider (50–100). Default 90 matches the prior FE default
  // so a workspace upgrading sees no shift in behaviour.
  @Prop({
    type: {
      complianceThresholdPct: {
        type: Number,
        default: 90,
        min: 50,
        max: 100,
      },
      defaulterAlerts: {
        type: {
          enabled: { type: Boolean, default: false },
          channels: {
            type: {
              inApp: { type: Boolean, default: true },
              email: { type: Boolean, default: false },
            },
            default: () => ({ inApp: true, email: false }),
            _id: false,
          },
          recipients: {
            type: {
              mode: {
                type: String,
                enum: ['managers', 'specificPeople', 'both'],
                default: 'managers',
              },
              specificPeople: {
                type: [{ type: Types.ObjectId, ref: 'User' }],
                default: [],
              },
            },
            default: () => ({ mode: 'managers', specificPeople: [] }),
            _id: false,
          },
        },
        default: () => ({
          enabled: false,
          channels: { inApp: true, email: false },
          recipients: { mode: 'managers', specificPeople: [] },
        }),
        _id: false,
      },
    },
    default: () => ({
      complianceThresholdPct: 90,
      defaulterAlerts: {
        enabled: false,
        channels: { inApp: true, email: false },
        recipients: { mode: 'managers', specificPeople: [] },
      },
    }),
    _id: false,
  })
  attendanceSettings?: {
    complianceThresholdPct: number;
    defaulterAlerts: {
      enabled: boolean;
      channels: { inApp: boolean; email: boolean };
      recipients: {
        mode: 'managers' | 'specificPeople' | 'both';
        specificPeople: Types.ObjectId[];
      };
    };
  };

  @Prop({ type: String, default: null })
  attendanceIngestToken: string | null;

  @Prop({ type: Date, default: null })
  attendanceIngestTokenRotatedAt: Date | null;

  // ── Phase 17 / FIN-16 — Party Intelligence settings (D-09, D-29) ─────────
  // Wave-1 plans (04 RFM, 06 greetings, 03 GSTIN monitor) read this namespace.
  // greetings.enabled defaults FALSE (DPDP — explicit owner opt-in required).
  // rfmTuning is undefined by default → cron uses D-03 hard-coded thresholds.
  // gstinPollCadenceDays = 7 mirrors D-11 weekly cadence.
  @Prop({
    type: {
      rfmTuning: {
        type: {
          newWindowDays: { type: Number },
          vipRfmFloor: { type: Number },
          dormantMin: { type: Number },
          dormantMax: { type: Number },
          churnedCutoff: { type: Number },
        },
        default: undefined,
        _id: false,
      },
      greetings: {
        type: {
          enabled: { type: Boolean, default: false },
          whatsapp: { type: Boolean, default: true },
          email: { type: Boolean, default: true },
          sms: { type: Boolean, default: true },
        },
        default: { enabled: false, whatsapp: true, email: true, sms: true },
        _id: false,
      },
      gstinPollCadenceDays: { type: Number, default: 7 },
    },
    default: undefined,
    _id: false,
  })
  partyIntelligence?: {
    rfmTuning?: {
      newWindowDays?: number;
      vipRfmFloor?: number;
      dormantMin?: number;
      dormantMax?: number;
      churnedCutoff?: number;
    };
    greetings?: {
      enabled: boolean;
      whatsapp: boolean;
      email: boolean;
      sms: boolean;
    };
    gstinPollCadenceDays?: number;
  };

  // ── App Lock — per-workspace idle timeout override ──────────────────────
  // When set, the frontend idle timer uses this value instead of the global
  // NEXT_PUBLIC_APP_LOCK_IDLE_MS / APP_LOCK_IDLE_MS default (300 000 ms).
  // null / undefined → use deployment default. Range: 1–30 minutes (ms).
  @Prop({ type: Number, default: null, min: 60_000, max: 1_800_000 })
  appLockIdleMs: number | null;

  // ── Soft-delete (user-side delete = hide + keep, never erase) ───────────
  // A user delete sets these; the row and all its workspace-scoped data are
  // retained for future offline recovery / admin tools. No user-facing restore.
  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date, default: null })
  deletedAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  deletedBy: Types.ObjectId | null;

  // ── Kiosk (M-02) ─────────────────────────────────────────────────────────
  @Prop({ type: Boolean, default: false })
  kioskEnabled: boolean;

  @Prop({ type: String, default: null })
  kioskTokenHash: string | null;

  @Prop({ type: [String], default: [] })
  kioskAllowedIpRanges: string[];

  @Prop({ type: Date, default: null })
  kioskTokenRotatedAt: Date | null;

  // ── Phase 24 — Machine Maintenance lead-time (D-10) ──────────────────────
  // Workspace default lead-time for "Maintenance Due" alerts (D-04).
  // Resolves: schedule.leadTimeDays ?? workspace.maintenanceLeadTimeDays ?? 7.
  @Prop({ type: Number, min: 1, max: 30, default: 7 })
  maintenanceLeadTimeDays: number;

  // ── Phase 25 — Production Utilisation Dashboard target (D-07) ────────────
  // Workspace default uptime target % for Phase 25 KPI card 4 (R/A/G band)
  // and uptime trend chart reference line. Per-machine override available
  // via Machine.uptimeTargetPct. Resolution lives in Plan 06.
  @Prop({ type: Number, min: 1, max: 100, default: 85 })
  productionUptimeTargetPct: number;

  // ── Wave 2 invite consolidation (2026-05-10) ────────────────────────────
  // Owner-toggled bypass for the standard hybrid acceptance UX. When false
  // (default), existing-user invites require an explicit one-click Accept
  // (consent check — random workspaces shouldn't auto-attach to a user's
  // account). When true, existing-user invites flip directly to active
  // status on creation — frictionless rollout for owners with a known team
  // who all already have CrewRoster accounts. New-user invites (no User
  // account yet) always go through atomic signup-and-accept regardless of
  // this flag — signup IS the consent.
  @Prop({ type: Boolean, default: false })
  autoAcceptKnownInvites: boolean;

  // ── Phase 2.2 — Per-workspace notification policy ─────────────────────────
  // Controls which notification events fire and through which channels.
  // `permissionChanges.enabled` is the workspace-level master toggle: when
  // false, NO channels fire even if `channels.*` are true. Default: in-app
  // only (email + SMS require explicit opt-in — avoids unexpected usage).
  @Prop({
    type: {
      permissionChanges: {
        type: {
          enabled: { type: Boolean, default: true },
          channels: {
            type: {
              inApp: { type: Boolean, default: true },
              email: { type: Boolean, default: false },
              sms: { type: Boolean, default: false },
            },
            default: () => ({ inApp: true, email: false, sms: false }),
            _id: false,
          },
        },
        default: () => ({
          enabled: true,
          channels: { inApp: true, email: false, sms: false },
        }),
        _id: false,
      },
    },
    default: () => ({
      permissionChanges: {
        enabled: true,
        channels: { inApp: true, email: false, sms: false },
      },
    }),
    _id: false,
  })
  notificationPolicy?: {
    permissionChanges: {
      enabled: boolean;
      channels: { inApp: boolean; email: boolean; sms: boolean };
    };
  };

  // ── Wave-3 Drift #36 — Workspace storage usage tracking ──────────────────
  // Tracks total bytes consumed by uploads in this workspace. Incremented
  // on successful upload, decremented on file delete. Compared against
  // entitlements.storage.totalGbPerWorkspace from owner's subscription.
  // -1 / null on entitlement = unlimited. lastUpdatedAt for ops dashboards.
  @Prop({
    type: {
      bytes: { type: Number, default: 0, min: 0 },
      lastUpdatedAt: { type: Date, default: null },
    },
    default: () => ({ bytes: 0, lastUpdatedAt: null }),
    _id: false,
  })
  storageUsage?: {
    bytes: number;
    lastUpdatedAt?: Date | null;
  };
}

export const WorkspaceSchema = SchemaFactory.createForClass(Workspace);

// Workspace code is globally unique so employee codes never collide across
// workspaces by value. Partial/sparse: only documents that actually carry the
// field are indexed (legacy workspaces backfill lazily on first use).
WorkspaceSchema.index(
  { workspaceCode: 1 },
  {
    unique: true,
    partialFilterExpression: { workspaceCode: { $type: 'string' } },
  },
);

// Attendance device-ingest token lookup (launch perf + abuse hardening —
// Workstream F). The ADMS ingest path (AttendanceIngestService.resolveToken)
// runs findOne({ attendanceIngestToken: rawToken }) on every device-handshake
// cache miss. attendanceIngestToken had NO index, so each miss was a full
// COLLSCAN of the workspaces collection — and because the /iclock prefix is
// @Public() and token MISSES are never cached, an unauthenticated probe with a
// bad token defeats the LRU cache and scans the largest tenant collection on
// every request (a mild DoS surface). Partial on $type:string mirrors the
// workspaceCode index: the field defaults to null, so only workspaces that have
// actually provisioned an ingest token are indexed. Non-unique for a safe
// additive build (the token is a random secret; collision is astronomically
// unlikely — unique is an optional hardening once confirmed collision-free).
WorkspaceSchema.index(
  { attendanceIngestToken: 1 },
  { partialFilterExpression: { attendanceIngestToken: { $type: 'string' } } },
);
