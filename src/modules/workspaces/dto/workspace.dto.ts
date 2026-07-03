import {
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

class BankAccountDto {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsString()
  @IsNotEmpty()
  label: string;
}

class DesignationLabelsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  en: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  'gu-en'?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  'hi-en'?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  gu?: string;
}

export class DesignationRecordDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  canonical: string;

  @IsOptional()
  @IsBoolean()
  isPreset?: boolean;

  @ValidateNested()
  @Type(() => DesignationLabelsDto)
  labels: DesignationLabelsDto;
}

export class AddDesignationDto {
  @ValidateNested()
  @Type(() => DesignationRecordDto)
  designation: DesignationRecordDto;
}

export class RenameDesignationDto {
  /** New canonical (en) label. Cascades to team_members where `designation` matched the old canonical. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  newCanonical: string;

  /** Optional per-locale label updates accompanying the rename. */
  @IsOptional()
  @ValidateNested()
  @Type(() => DesignationLabelsDto)
  labels?: DesignationLabelsDto;
}

export class CreateWorkspaceDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsOptional()
  businessType?: string;

  @IsString()
  @IsOptional()
  location?: string;

  // Company postal address — single source of truth for the ID card.
  @IsString()
  @IsOptional()
  @MaxLength(300)
  address?: string;

  @IsString()
  @IsOptional()
  timezone?: string;

  @IsString({ each: true })
  @IsOptional()
  designations?: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BankAccountDto)
  @IsOptional()
  bankAccounts?: BankAccountDto[];

  // Business (firm) profile fields — captured inline on workspace creation.
  // All optional — user can Skip and complete later via business-setup wizard.
  @IsString()
  @IsOptional()
  firmName?: string;

  @IsString()
  @IsOptional()
  gstin?: string;

  @IsString()
  @IsOptional()
  pan?: string;

  @IsInt()
  @Min(1)
  @Max(12)
  @IsOptional()
  fyStartMonth?: number;
}

/**
 * Employee self-service policy (Access Control Initiative §8). Both flags
 * default OFF in the schema; the owner opts in per workspace.
 */
class SelfServiceConfigDto {
  @IsBoolean()
  @IsOptional()
  selfPunch?: boolean;

  @IsBoolean()
  @IsOptional()
  selfLeaveApply?: boolean;
}

/**
 * Attendance-module workspace preferences. Currently hosts the compliance
 * threshold (defaulters cutoff %) shared across all managers in the
 * workspace. Range mirrors the FE Compliance slider (50–100).
 */
class AttendanceSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(100)
  complianceThresholdPct?: number;
}

export class UpdateWorkspaceDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  businessType?: string;

  @IsString()
  @IsOptional()
  location?: string;

  // Company postal address — single source of truth for the ID card.
  @IsString()
  @IsOptional()
  @MaxLength(300)
  address?: string;

  @IsString()
  @IsOptional()
  timezone?: string;

  @IsString({ each: true })
  @IsOptional()
  designations?: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BankAccountDto)
  @IsOptional()
  bankAccounts?: BankAccountDto[];

  // ── Phase 24 — Maintenance lead-time (D-10) ─────────────────────────────
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  maintenanceLeadTimeDays?: number;

  // ── Phase 25 — Production utilisation target (D-07) ─────────────────────
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  productionUptimeTargetPct?: number;

  // ── App Lock — per-workspace idle timeout (ms) ─────────────────────────
  // null resets to deployment default. Range: 60 000 (1 min) – 1 800 000 (30 min).
  @IsOptional()
  @IsInt()
  @Min(60_000)
  @Max(1_800_000)
  appLockIdleMs?: number | null;

  // ── Access Control Initiative §8 — employee self-service policy ────────
  @IsOptional()
  @ValidateNested()
  @Type(() => SelfServiceConfigDto)
  selfServiceConfig?: SelfServiceConfigDto;

  // ── Attendance-module workspace preferences (Compliance threshold) ─────
  @IsOptional()
  @ValidateNested()
  @Type(() => AttendanceSettingsDto)
  attendanceSettings?: AttendanceSettingsDto;
}

const phoneRegex = /^\+?[1-9]\d{1,14}$/;

export class InviteMemberDto {
  @IsNotEmpty()
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Matches(phoneRegex, { message: 'Invalid mobile number format' })
  mobile?: string;

  @IsMongoId()
  @IsOptional()
  roleId?: string;

  // ── Wave 2 invite consolidation (2026-05-10) ───────────────────────────
  // When set, the invite is linked to an existing TeamMember directory
  // record. On accept, the TeamMember gets hasAppAccess=true + linkedUserId
  // set + linkedWorkspaceMemberId pointing back to the new bridge row.
  // Replaces the deprecated `team.grantAccess` flow — same outcome, single
  // canonical token-resolution path.
  @IsMongoId()
  @IsOptional()
  teamMemberId?: string;

  // ── P1.5 (2026-05-14) — sendMethod parity with deprecated grantAccess ──
  // 'auto' / 'both' → dispatcher sends email + SMS as available.
  // 'link'          → dispatcher skips email + SMS; response includes the
  //                   raw inviteToken so the owner can copy/share manually
  //                   (e.g. WhatsApp paste).
  // Default 'auto' preserves the current behaviour for callers that don't
  // specify a method.
  @IsOptional()
  @IsIn(['auto', 'link', 'both'])
  sendMethod?: 'auto' | 'link' | 'both';

  // ── P2.0.2 (2026-05-15) — per-channel grant control ──────────────────
  // When present, overrides the channel mix derived from sendMethod and
  // fires exactly the listed channels. Empty array = generate token, no
  // dispatch (the response still includes the raw inviteToken). Mirrors
  // ResendInviteDto.channels — same wire shape lets the FE share one
  // picker component across grant + resend.
  //
  //   - 'email'  → email if address available
  //   - 'sms'    → SMS if mobile available
  //   - 'in_app' → in-app notification when the invitee's mobile/email maps
  //                to a User account (warm); silent otherwise
  @IsArray()
  @IsOptional()
  @IsIn(['email', 'sms', 'in_app'], { each: true })
  channels?: ('email' | 'sms' | 'in_app')[];
}

export class ChangeMemberRoleDto {
  @IsMongoId()
  @IsOptional()
  roleId?: string; // Null means system Member role
}

export class BrandingDto {
  @IsString()
  @IsOptional()
  logo?: string;

  @IsString()
  @IsOptional()
  pdfHeaderLogo?: string;

  @IsString()
  @IsOptional()
  pdfWatermarkLogo?: string;

  @IsString()
  @IsOptional()
  @MaxLength(300)
  pdfFooterDetails?: string;

  // Owner-uploaded ID-card background image (light watermark on each card).
  @IsString()
  @IsOptional()
  idCardBackground?: string;
}

export class ExportPreferencesDto {
  @IsBoolean()
  @IsOptional()
  includeHeaderLogo?: boolean;

  @IsBoolean()
  @IsOptional()
  includeFooter?: boolean;

  @IsBoolean()
  @IsOptional()
  includeWatermark?: boolean;
}

export class EmployeeCodeSettingsDto {
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  // Must contain a sequence token ({#}, {##}, {###}, or {####}).
  // Allowed chars keep the rendered code within [A-Za-z0-9_-] once tokens
  // are substituted (the member schema enforces the final-form regex too).
  @IsString()
  @MaxLength(64)
  @Matches(/\{#{1,4}\}/, {
    message: 'Format must include a sequence token ({#}, {##}, {###}, or {####})',
  })
  @Matches(/^[A-Za-z0-9_\-{}#]+$/, {
    message: 'Format may only contain letters, digits, hyphens, underscores, and tokens',
  })
  @IsOptional()
  format?: string;

  @IsString()
  @MaxLength(16)
  @Matches(/^[A-Za-z0-9_-]*$/, {
    message: 'Prefix may only contain letters, digits, hyphens, and underscores',
  })
  @IsOptional()
  prefix?: string;

  @IsInt()
  @Min(1)
  @Max(9_999_999)
  @IsOptional()
  startingNumber?: number;

  @IsBoolean()
  @IsOptional()
  allowCustom?: boolean;
}

// ── Defaulter Alerts config DTO (Attendance Completion initiative) ──────────

class DefaulterAlertsChannelsDto {
  @IsBoolean()
  inApp: boolean;

  @IsBoolean()
  email: boolean;
}

class DefaulterAlertsRecipientsDto {
  @IsEnum(['managers', 'specificPeople', 'both'])
  mode: 'managers' | 'specificPeople' | 'both';

  @IsArray()
  @IsMongoId({ each: true })
  specificPeople: string[];
}

export class DefaulterAlertsConfigDto {
  @IsBoolean()
  enabled: boolean;

  @ValidateNested()
  @Type(() => DefaulterAlertsChannelsDto)
  channels: DefaulterAlertsChannelsDto;

  @ValidateNested()
  @Type(() => DefaulterAlertsRecipientsDto)
  recipients: DefaulterAlertsRecipientsDto;
}
