import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * A single component line consumed during Issue Materials.
 * lotId / batchId / serialNos are optional depending on whether the item
 * tracks lots, batches, or serials (D-06).
 */
export class IssueComponentLineDto {
  @IsNotEmpty()
  @IsMongoId()
  itemId: string;

  @IsNumber()
  @Min(0)
  qty: number;

  @IsString()
  unit: string;

  @IsNotEmpty()
  @IsMongoId()
  godownId: string;

  @IsOptional()
  @IsMongoId()
  lotId?: string;

  @IsOptional()
  @IsMongoId()
  batchId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  serialNos?: string[];
}

/**
 * Input for POST /manufacturing-vouchers/:mvId/issue — transitions draft → in_progress.
 *
 * Service validates GodownBalance per component before accepting (D-19).
 * Audit fields (issuedBy) injected from req.user — not accepted as input (T-F10-W3-04).
 */
export class IssueMaterialsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => IssueComponentLineDto)
  componentsConsumed: IssueComponentLineDto[];
}
