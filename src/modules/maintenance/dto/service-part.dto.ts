import {
  IsBoolean,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * ServicePartDto — DTO mirror of ServicePart subdoc (24-RESEARCH.md §4).
 *
 * XOR validation of `{ itemId, freeTextName }` is enforced at the schema
 * layer (`ServicePartSchema.pre('validate')` — surfaces
 * `SERVICE_PART_REQUIRES_ITEM_OR_TEXT`). The DTO leaves both optional so the
 * schema-layer validator owns the rule single-sourced.
 */
export class ServicePartDto {
  @IsOptional()
  @IsMongoId()
  itemId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  freeTextName?: string;

  @IsNumber()
  @Min(0)
  quantity!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  unitCostPaise?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  notes?: string;
}

/**
 * ChecklistTickDto — DTO mirror of the ChecklistTick subdoc.
 */
export class ChecklistTickDto {
  @IsString()
  @MaxLength(200)
  item!: string;

  @IsBoolean()
  ticked!: boolean;
}
