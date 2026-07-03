import {
  IsString,
  IsNumber,
  IsBoolean,
  IsArray,
  IsOptional,
  IsEnum,
  Min,
  Max,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import {
  AddOnType,
  AddOnBillingCycle,
} from '../schemas/add-on-definition.schema';

class EntitlementDeltaDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  extraWorkspaces?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  extraMembersPerWorkspace?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  extraTotalMembers?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  extraSessionsPerPlatform?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  extraSessionsTotal?: number;

  @IsOptional()
  @IsString()
  targetModule?: string;

  @IsOptional()
  @IsString()
  targetSubFeatureModule?: string;

  @IsOptional()
  @IsString()
  targetSubFeatureKey?: string;

  @IsOptional()
  @IsEnum(['locked', 'limited', 'full'])
  targetSubFeatureAccess?: 'locked' | 'limited' | 'full';

  @IsOptional()
  featureOverrides?: Record<string, boolean>;
}

export class CreateAddOnDefinitionDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  slug: string;

  @Transform(({ value }) => {
    if (!value) return value;
    if (
      typeof value === 'string' &&
      ['quota', 'module', 'subfeature'].includes(value)
    ) {
      return value;
    }
    return value;
  })
  @IsEnum(AddOnType)
  type: AddOnType;

  @Type(() => EntitlementDeltaDto)
  @Transform(({ value }) => value || {})
  entitlementDelta: EntitlementDeltaDto;

  @Transform(({ value }) => Number(value) || 0)
  @IsNumber()
  @Min(0)
  monthlyPrice: number;

  @Transform(({ value }) => Number(value) || 0)
  @IsNumber()
  @Min(0)
  yearlyPrice: number;

  @Transform(({ value }) => Number(value) || 0)
  @IsNumber()
  @Min(0)
  lifetimePrice: number;

  @IsOptional()
  @IsBoolean()
  stackable?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(-1)
  maxStack?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  applicableTiers?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsNumber()
  displayOrder?: number;

  @IsOptional()
  @IsEnum(AddOnBillingCycle)
  defaultBillingCycle?: AddOnBillingCycle;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedBillingCycles?: string[];

  @IsOptional()
  @IsBoolean()
  allowProratedBilling?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minDaysBeforeRenewal?: number;
}

export class UpdateAddOnDefinitionDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsEnum(AddOnType)
  type?: AddOnType;

  @IsOptional()
  @Type(() => EntitlementDeltaDto)
  entitlementDelta?: EntitlementDeltaDto;

  @IsOptional()
  @IsNumber()
  @Min(0)
  monthlyPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  yearlyPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  lifetimePrice?: number;

  @IsOptional()
  @IsBoolean()
  stackable?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(-1)
  maxStack?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  applicableTiers?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsNumber()
  displayOrder?: number;

  @IsOptional()
  @IsEnum(AddOnBillingCycle)
  defaultBillingCycle?: AddOnBillingCycle;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedBillingCycles?: string[];

  @IsOptional()
  @IsBoolean()
  allowProratedBilling?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minDaysBeforeRenewal?: number;
}
