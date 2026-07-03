import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
  IsEmail,
  MinLength,
  MaxLength,
} from 'class-validator';
import { PlanEntitlementsDto } from '../../subscriptions/dto/subscription.dto';
import { PlatformAccess } from '../../../common/enums/platform-access.enum';
import { AppModule } from '../../../common/enums/modules.enum';

export class AdminPaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  search?: string;

  // Optional exact-match facet (used by the feedback console: 'page' | 'general').
  // Other admin lists ignore it.
  @IsOptional()
  @IsString()
  scope?: string;

  // Optional exact-match status facet (used by the feedback console).
  @IsOptional()
  @IsString()
  status?: string;

  // Query-string booleans arrive as the STRINGS 'true'/'false'. @Type(() => Boolean)
  // was WRONG here: Boolean('false') === true, so an unchecked box still enabled
  // the filter. Parse the string explicitly so 'false' actually means false.
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value === 'true' : value))
  @IsBoolean()
  includeDeleted?: boolean;

  // Mirror of includeDeleted for seeded demo/sample accounts (User.isDemo).
  // Absent/false ⇒ demo accounts are hidden; true ⇒ they are listed too, so
  // the admin can inspect launch demo content without it polluting the default
  // users view. Same explicit string parse as includeDeleted (Boolean('false')
  // gotcha).
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value === 'true' : value))
  @IsBoolean()
  includeDemo?: boolean;

  // Product facet for the unified users console: 'erp' (ERP footprint),
  // 'connect' (Connect footprint), 'both' (intersection), or 'all'/absent.
  // A bundle user counts as BOTH erp and connect.
  @IsOptional()
  @IsEnum(['all', 'erp', 'connect', 'both'])
  product?: 'all' | 'erp' | 'connect' | 'both';
}

export class UpdateUserStatusDto {
  @IsBoolean()
  isActive: boolean;

  @IsString()
  @IsOptional()
  note?: string;
}

export class DeleteUserDto {
  @IsOptional()
  @IsBoolean()
  permanent?: boolean;
}

/**
 * OQ-3 DPDP account erasure. Admin-only. `confirm` MUST be `true` — a
 * mistyped or default-shaped request can never trigger an irreversible
 * identity scrub. `reason` is captured in the audit entry (e.g. a DPDP
 * erasure-request ticket id).
 */
export class EraseUserDto {
  @IsBoolean()
  confirm: boolean;

  @IsString()
  @IsOptional()
  reason?: string;
}

/**
 * Account-deletion Phase 1 — admin-mediated recovery of a scheduled deletion
 * (ACCOUNT-DELETION-AND-DPDP-PLAN.md §5/§6). `reason` is captured in the audit
 * trail (e.g. the support ticket where the user asked to recover). The target
 * is the path id under IsAdminGuard — never a body-supplied user id.
 */
export class AdminRestoreDeletionDto {
  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}

export class AdminAssignPlanDto {
  @IsMongoId() @IsNotEmpty() userId: string;
  @IsMongoId() @IsNotEmpty() planId: string;
  @IsEnum(['monthly', 'yearly', 'lifetime']) billingCycle: 'monthly' | 'yearly' | 'lifetime';
  @ValidateNested()
  @Type(() => PlanEntitlementsDto)
  entitlements: PlanEntitlementsDto;
  @IsString() @IsOptional() note?: string;
}

export class AdminCustomAssignDto {
  @IsMongoId() @IsNotEmpty() userId: string;
  @IsMongoId() @IsOptional() planId?: string;
  // Product line for the new subscription. With a base plan, defaults to the
  // plan's product; without one, defaults to 'erp'. Lets an admin hand-tune a
  // Connect (or bundle) subscription without a catalogue plan.
  @IsEnum(['erp', 'connect', 'bundle']) @IsOptional() product?: 'erp' | 'connect' | 'bundle';
  @ValidateNested()
  @Type(() => PlanEntitlementsDto)
  entitlements: PlanEntitlementsDto;
  @IsEnum(PlatformAccess)
  @IsOptional()
  platformAccess?: PlatformAccess;
  @IsNumber()
  @IsOptional()
  sessionLimitOverride?: number | null;
  @IsString() @IsNotEmpty() startDate: string;
  @IsString() @IsNotEmpty() endDate: string;
  @IsEnum(['monthly', 'yearly', 'lifetime']) billingCycle: 'monthly' | 'yearly' | 'lifetime';
  @IsEnum(['active', 'trial']) @IsOptional() status?: 'active' | 'trial';
  @IsString() @IsOptional() note?: string;
}

/**
 * Admin-side "assign the configured default ERP plan" payload — used by both the
 * single-user row action (POST /admin/users/:id/assign-default-plan) and the bulk
 * backfill (POST /admin/subscriptions/assign-default-missing). Only an optional
 * free-text `note` for the audit trail; the plan itself is resolved server-side
 * via SubscriptionsService.getDefaultPlanId('erp') so the admin never picks it.
 */
export class AdminAssignDefaultPlanDto {
  @IsOptional()
  @IsString()
  note?: string;
}

export class AdminUpdateSubscriptionDto {
  @IsEnum(['active', 'cancelled', 'expired', 'trial'])
  @IsOptional()
  status?: string;
  @IsString() @IsOptional() currentPeriodEnd?: string;
  @ValidateNested()
  @IsOptional()
  @Type(() => PlanEntitlementsDto)
  entitlements?: PlanEntitlementsDto;
  @IsString() @IsOptional() note?: string;
}

export class AdminRevokeSubscriptionDto {
  @IsEnum(['no-plan', 'assign-free', 'assign-plan'])
  @IsNotEmpty()
  action: 'no-plan' | 'assign-free' | 'assign-plan';

  @IsMongoId()
  @IsOptional()
  targetPlanId?: string;

  @IsString()
  @IsOptional()
  note?: string;
}

/**
 * Admin-dynamic 45-day trial-banner config patched via PATCH /admin/settings.
 * Mirrors the AppSettings.trialBanner sub-doc. Both fields optional so a patch
 * can flip just one. `headlineOverride` empty = FE renders its localized default.
 */
export class TrialBannerSettingsDto {
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsString()
  @IsOptional()
  headlineOverride?: string;
}

export class UpdateSettingsDto {
  // Optional so a PARTIAL patch validates: the settings page saves trialBanner
  // on its own (without resending freeTierEnabled), and the free-tier toggle
  // saves freeTierEnabled on its own. updateSettings $sets only the provided
  // keys, so an omitted field leaves the stored value untouched. Without this
  // @IsOptional a trialBanner-only save 400s on "freeTierEnabled must be boolean".
  @IsBoolean()
  @IsOptional()
  freeTierEnabled?: boolean;

  // The whole DTO is `$set` onto AppSettings by AdminService.updateSettings, so
  // a validated nested trialBanner flows through with no service change.
  @ValidateNested()
  @IsOptional()
  @Type(() => TrialBannerSettingsDto)
  trialBanner?: TrialBannerSettingsDto;

  // Full-replace list of modules the web shows as "Coming Soon" when locked
  // (instead of the upgrade prompt). Saved on its own by the admin Module
  // Availability card; presentation-only (SubscriptionGuard still 403s).
  @IsOptional()
  @IsArray()
  @IsEnum(AppModule, { each: true })
  comingSoonModules?: AppModule[];
}

export class CreateUserDto {
  @IsString() @IsNotEmpty() name: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  mobile?: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsBoolean()
  @IsOptional()
  isAdmin?: boolean;

  @IsBoolean()
  @IsOptional()
  isEmailVerified?: boolean;

  @IsBoolean()
  @IsOptional()
  sendWelcomeEmail?: boolean;

  @IsBoolean()
  @IsOptional()
  createWorkspace?: boolean;

  @IsString()
  @IsOptional()
  workspaceName?: string;

  @IsString()
  @IsOptional()
  workspaceBusinessType?: string;
}

export class DefaultBrandingDto {
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
}
