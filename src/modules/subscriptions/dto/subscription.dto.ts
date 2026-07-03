import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { AppModule } from '../../../common/enums/modules.enum';
import { FeatureAccessLevel } from '../../../common/enums/feature-access.enum';
import { PlatformAccess } from '../../../common/enums/platform-access.enum';
import {
  MODULE_FEATURES_MAP,
  getSubFeatureDefinition,
} from '../../../common/constants/module-features.registry';

class PlanFeaturesDto {
  @IsBoolean() @IsOptional() export?: boolean;
  @IsBoolean() @IsOptional() apiAccess?: boolean;
  @IsBoolean() @IsOptional() advancedRbac?: boolean;
  @IsBoolean() @IsOptional() customRoles?: boolean;
  @IsBoolean() @IsOptional() shifts?: boolean;
  @IsBoolean() @IsOptional() bills?: boolean;
}

/**
 * Connect (network / marketplace) plan allowances. Mirrors the Plan schema's
 * PlanConnectEntitlements sub-block (M0.1). `-1` = unlimited. All optional so
 * ERP plans omit it entirely.
 */
class PlanConnectEntitlementsDto {
  @IsNumber() @IsOptional() maxListings?: number;
  @IsNumber() @IsOptional() leadsPerMonth?: number;
  @IsNumber() @IsOptional() includedBoostCredits?: number;
  @IsBoolean() @IsOptional() verifiedBadge?: boolean;
  @IsNumber() @IsOptional() searchPriority?: number;
  // Count caps a Connect/bundle PACKAGE can express (-1 = unlimited). Without
  // these the validation pipe strips them and a package can't set the
  // "1 company / 1 storefront / N jobs" limits.
  @IsNumber() @IsOptional() maxCompanyPages?: number;
  @IsNumber() @IsOptional() maxStorefronts?: number;
  @IsNumber() @IsOptional() maxJobs?: number;
  // The remaining schema fields. These MUST be whitelisted too: a stored Connect
  // plan carries them (Mongoose fills the defaults), so the admin assign flow
  // re-sends the full connect block — without them `forbidNonWhitelisted` 400s
  // the whole assignment.
  @IsNumber() @IsOptional() storageMb?: number;
  @IsIn(['freeze', 'hide_newest']) @IsOptional() overLimitPolicy?: 'freeze' | 'hide_newest';
  @IsNumber() @IsOptional() overLimitGraceDays?: number;
}

class ModuleSubFeatureAccessDto {
  @IsString() @IsNotEmpty() key: string;
  @IsEnum(FeatureAccessLevel) access: FeatureAccessLevel;
}

export class ModuleAccessEntryDto {
  @IsEnum(AppModule) module: AppModule;

  @IsBoolean() enabled: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ModuleSubFeatureAccessDto)
  subFeatures: ModuleSubFeatureAccessDto[];
}

export class PlanEntitlementsDto {
  @IsNumber() maxWorkspaces: number;
  @IsNumber() maxMembersPerWorkspace: number;
  @IsNumber() maxTotalMembers: number;
  @IsEnum(AppModule, { each: true }) modules: AppModule[];
  @ValidateNested() @Type(() => PlanFeaturesDto) features: PlanFeaturesDto;

  @IsArray()
  @ValidateNested({ each: true })
  @IsOptional()
  @Type(() => ModuleAccessEntryDto)
  @ArrayMinSize(0)
  moduleAccess?: ModuleAccessEntryDto[];

  @IsEnum(PlatformAccess)
  @IsOptional()
  platformAccess?: PlatformAccess;

  @IsNumber()
  @IsOptional()
  maxSessionsPerPlatform?: number;

  @IsNumber()
  @IsOptional()
  maxSessionsTotal?: number;

  // Monthly email send cap (0 = unlimited). The admin plan form always sends
  // this; without whitelisting it, forbidNonWhitelisted 400s the whole create
  // ("entitlements.property emailsPerMonth should not exist"). Consumed by the
  // workspace email-limit feature (appliedEntitlements.emailsPerMonth).
  @IsNumber()
  @IsOptional()
  emailsPerMonth?: number;

  // Communications config (reminder channels / caps) the admin plan form sends
  // (CommunicationsEditor). Whitelisted loosely so forbidNonWhitelisted does not
  // 400 the create; the Plan schema stores entitlements as a flexible object.
  @IsObject()
  @IsOptional()
  communications?: Record<string, unknown>;

  @ValidateNested()
  @IsOptional()
  @Type(() => PlanConnectEntitlementsDto)
  connect?: PlanConnectEntitlementsDto;
}

// ── Localized text DTO ────────────────────────────────────────────────────────

export class LocalizedTextDto {
  @IsString() en: string;
  @IsOptional() @IsString() 'gu-en'?: string;
  @IsOptional() @IsString() 'hi-en'?: string;
  @IsOptional() @IsString() gu?: string;
}

// ── Plan badge DTO ────────────────────────────────────────────────────────────

const BADGE_TONES = ['brand', 'gold', 'success', 'info', 'neutral', 'danger'] as const;

export class PlanBadgeDto {
  @ValidateNested()
  @Type(() => LocalizedTextDto)
  label: LocalizedTextDto;

  @IsOptional()
  @IsString()
  @IsIn(BADGE_TONES)
  tone?: string;
}

// ── Plan marketing DTO ────────────────────────────────────────────────────────

export class PlanMarketingDto {
  @IsOptional() @IsInt() @Min(0) displayOrder?: number;

  @IsOptional() @IsBoolean() isHighlighted?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => PlanBadgeDto)
  badge?: PlanBadgeDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LocalizedTextDto)
  tagline?: LocalizedTextDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LocalizedTextDto)
  featureHighlights?: LocalizedTextDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => LocalizedTextDto)
  ctaLabel?: LocalizedTextDto;

  @IsOptional() @IsNumber() @IsPositive() compareAtMonthlyPrice?: number;

  @IsOptional() @IsNumber() @IsPositive() compareAtYearlyPrice?: number;

  @IsOptional() @IsString() featuredCouponCode?: string;
}

export class CreatePlanDto {
  @IsString() @IsNotEmpty() name: string;
  @IsString() @IsNotEmpty() tier: string;
  /** Product line this plan sells. Defaults to 'erp' at the schema level. */
  @IsIn(['erp', 'connect', 'bundle']) @IsOptional() product?: string;
  @IsNumber() monthlyPrice: number;
  @IsNumber() yearlyPrice: number;
  @ValidateNested()
  @Type(() => PlanEntitlementsDto)
  entitlements: PlanEntitlementsDto;
  @IsBoolean() @IsOptional() isActive?: boolean;
  /** Days of free trial before the first charge. 0 = no trial (Phase 2). */
  @IsOptional() @IsInt() @Min(0) trialDurationDays?: number;
  /**
   * % off the yearly price for a single upfront payment (0..100; 0 = none).
   * Installments pay the full yearly price at 0% interest. Admin-tunable.
   */
  @IsOptional() @IsNumber() @Min(0) @Max(100) upfrontDiscountPercent?: number;
  /** Whether the 'pay monthly in installments' option is offered for this plan. */
  @IsOptional() @IsBoolean() installmentsEnabled?: boolean;
  /** Number of monthly installments the yearly price is split into (1..24, default 12). */
  @IsOptional() @IsInt() @Min(1) @Max(24) installmentMonths?: number;
  /**
   * Mark this plan as the per-product default new sign-ups are auto-assigned
   * (Phase 2). The admin create/update service enforces exactly one per product.
   */
  @IsOptional() @IsBoolean() isDefault?: boolean;
  /**
   * Mark this plan as the per-product TRIAL plan (its entitlements = trial
   * access, its trialDurationDays = trial length). The admin create/update
   * service enforces exactly one per product and forces isPubliclyVisible:false
   * (system plan, not buyable). MUST be whitelisted here or forbidNonWhitelisted
   * strips it before it reaches the service.
   */
  @IsOptional() @IsBoolean() isTrialPlan?: boolean;
  // ── GST levers (Task 3 — optional/configurable subscription-plan GST) ──
  // Previously OMITTED here, so the global forbidNonWhitelisted pipe STRIPPED
  // them on the catalogue create/update path — the admin form could never set
  // them. `gstEnabled` false drops GST for this plan (defaults ON at the schema
  // level). `updatePlan` uses Partial<CreatePlanDto>, so this covers PATCH too.
  @IsOptional() @IsBoolean() gstEnabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(50) gstRatePercent?: number;
  @IsOptional() @IsBoolean() isPriceTaxInclusive?: boolean;
  @IsOptional()
  @ValidateNested()
  @Type(() => PlanMarketingDto)
  marketing?: PlanMarketingDto;
}

export class UpdateSubscriptionDto {
  @IsMongoId() planId: string;
  @IsEnum(['monthly', 'yearly']) billingCycle: string;
  @IsBoolean() @IsOptional() activateImmediately?: boolean;
}

export function validateModuleAccess(moduleAccess: ModuleAccessEntryDto[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const moduleKeys = new Set<string>();
  const validModules: AppModule[] = Object.values(AppModule).filter((m) => m !== AppModule.BILLS);

  for (const entry of moduleAccess) {
    if (!validModules.includes(entry.module)) {
      errors.push(
        `Invalid module '${entry.module}'. Valid modules are: ${validModules.join(', ')}`,
      );
      continue;
    }

    if (moduleKeys.has(entry.module)) {
      errors.push(`Duplicate module entry '${entry.module}'`);
      continue;
    }
    moduleKeys.add(entry.module);

    const moduleDef = MODULE_FEATURES_MAP[entry.module];
    if (!moduleDef) {
      errors.push(`Unknown module '${entry.module}'`);
      continue;
    }

    const validSubFeatureKeys = new Set(moduleDef.subFeatures.map((sf) => sf.key));

    for (const sf of entry.subFeatures) {
      if (!validSubFeatureKeys.has(sf.key)) {
        errors.push(
          `Invalid sub-feature key '${sf.key}' for module '${entry.module}'. Valid sub-features are: ${Array.from(validSubFeatureKeys).join(', ')}`,
        );
        continue;
      }

      const sfDef = getSubFeatureDefinition(entry.module, sf.key);
      if (sfDef && !sfDef.supportsLimited && sf.access === FeatureAccessLevel.LIMITED) {
        errors.push(
          `Sub-feature '${sf.key}' in module '${entry.module}' does not support 'limited' access level`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
