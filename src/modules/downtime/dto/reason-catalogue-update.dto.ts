import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  REASON_CATEGORIES,
  ReasonCategory,
} from '../schemas/downtime-reason-config.schema';

/**
 * Single reason-code item inside a catalogue PATCH payload.
 *
 * - `_id` absence  → "add new code" (server generates kebab key from label)
 * - `_id` presence → "update existing" (key + system flags ignored / locked)
 *
 * `isSystem` is server-trusted (ignored on PATCH). `key` is ignored on update
 * (immutable post-create); when provided on a system-code update it must equal
 * the existing key or the service throws DOWNTIME_REASON_KEY_IMMUTABLE.
 */
export class ReasonCodeUpdateItemDto {
  @IsOptional()
  @IsMongoId()
  _id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  key?: string;

  @IsString()
  @MaxLength(120)
  label!: string;

  @IsEnum(REASON_CATEGORIES)
  category!: ReasonCategory;

  @IsOptional()
  @IsBoolean()
  isSystem?: boolean;

  @IsOptional()
  @IsBoolean()
  isDisabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/**
 * Full-replace payload for the workspace reason catalogue (D-02).
 *
 * Hard cap of 50 codes per workspace (DoS guard).
 */
export class ReasonCatalogueUpdateDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ReasonCodeUpdateItemDto)
  codes!: ReasonCodeUpdateItemDto[];
}
