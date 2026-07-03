import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ChecklistTickDto, ServicePartDto } from './service-part.dto';

/**
 * CreateServiceLogDto (24-RESEARCH.md §4).
 *
 * `partsReplaced` capped at 30 (DoS guard, mirrors schema-layer validator).
 * Per-row XOR (itemId vs freeTextName) is enforced at the schema layer.
 *
 * `scheduleId` is optional — null/missing = ad-hoc service (D-02).
 */
export class CreateServiceLogDto {
  @IsOptional()
  @IsMongoId()
  scheduleId?: string;

  @IsDateString()
  servicedAt!: string;

  @IsDateString()
  serviceEndAt!: string;

  @IsOptional()
  @IsMongoId()
  technicianId?: string;

  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ServicePartDto)
  partsReplaced!: ServicePartDto[];

  @IsOptional()
  @IsInt()
  @Min(0)
  costPaise?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChecklistTickDto)
  checklistTicked?: ChecklistTickDto[];
}
