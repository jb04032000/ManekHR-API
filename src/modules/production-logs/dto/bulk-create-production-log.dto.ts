import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsMongoId,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CreateProductionLogDto } from './create-production-log.dto';

/**
 * Single bulk item — same shape as CreateProductionLogDto BUT machineId is REQUIRED
 * because the bulk endpoint has no /:machineId path param (D-05).
 */
export class BulkProductionLogItemDto extends CreateProductionLogDto {
  @IsMongoId()
  machineId!: string;
}

export class BulkCreateProductionLogDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BulkProductionLogItemDto)
  entries!: BulkProductionLogItemDto[];
}
