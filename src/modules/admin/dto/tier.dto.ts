import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsBoolean,
  ValidateNested,
  Min,
  Max,
  IsIn,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

const ANT_DESIGN_COLORS = [
  'default',
  'blue',
  'gold',
  'purple',
  'green',
  'red',
  'orange',
  'cyan',
  'geekblue',
  'lime',
  'magenta',
  'volcano',
] as const;

export class TierDefaultEntitlementsDto {
  @IsNumber()
  @IsOptional()
  @Min(-1)
  maxWorkspaces?: number = 1;

  @IsNumber()
  @IsOptional()
  @Min(-1)
  maxMembersPerWorkspace?: number = 5;

  @IsNumber()
  @IsOptional()
  @Min(-1)
  maxTotalMembers?: number = 5;
}

export class TierSubFeatureAccessDto {
  @IsString()
  @IsNotEmpty()
  key: string;

  @IsString()
  @IsIn(['locked', 'limited', 'full'])
  @IsOptional()
  access?: string = 'full';
}

export class TierDefaultModuleAccessDto {
  @IsString()
  @IsNotEmpty()
  module: string;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean = false;

  @ValidateNested({ each: true })
  @Type(() => TierSubFeatureAccessDto)
  @IsOptional()
  subFeatures?: TierSubFeatureAccessDto[] = [];
}

export class CreateTierDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Key must be lowercase alphanumeric with hyphens only',
  })
  key: string;

  /** Product line this tier belongs to. Defaults to 'erp' at the schema level. */
  @IsIn(['erp', 'connect', 'bundle'])
  @IsOptional()
  product?: string;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(100)
  displayOrder?: number = 0;

  @IsString()
  @IsNotEmpty()
  @IsIn([...ANT_DESIGN_COLORS] as any[], {
    message: `Color must be a valid hex color or one of: ${ANT_DESIGN_COLORS.join(', ')}`,
  })
  color: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean = true;

  @ValidateNested()
  @Type(() => TierDefaultEntitlementsDto)
  @IsOptional()
  defaultEntitlements?: TierDefaultEntitlementsDto;

  @ValidateNested({ each: true })
  @Type(() => TierDefaultModuleAccessDto)
  @IsOptional()
  defaultModuleAccess?: TierDefaultModuleAccessDto[];
}

export class UpdateTierDto {
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  name?: string;

  @IsIn(['erp', 'connect', 'bundle'])
  @IsOptional()
  product?: string;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(100)
  displayOrder?: number;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  @IsIn([...ANT_DESIGN_COLORS] as any[], {
    message: `Color must be a valid hex color or one of: ${ANT_DESIGN_COLORS.join(', ')}`,
  })
  color?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ValidateNested()
  @Type(() => TierDefaultEntitlementsDto)
  @IsOptional()
  defaultEntitlements?: TierDefaultEntitlementsDto;

  @ValidateNested({ each: true })
  @Type(() => TierDefaultModuleAccessDto)
  @IsOptional()
  defaultModuleAccess?: TierDefaultModuleAccessDto[];
}
