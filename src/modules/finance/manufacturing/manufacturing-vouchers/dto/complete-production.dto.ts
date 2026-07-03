import { Type } from 'class-transformer';
import {
  IsArray,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * A single by-product produced during completion.
 * costAllocatedPaise is computed by the service from BoM NRV data — not accepted as input.
 */
export class CompleteByProductDto {
  @IsMongoId()
  itemId: string;

  @IsNumber()
  @Min(0)
  qty: number;

  @IsString()
  unit: string;

  @IsMongoId()
  godownId: string;
}

/**
 * Input for POST /manufacturing-vouchers/:mvId/complete — transitions in_progress → completed.
 *
 * actualFinishedQty may be less than finishedQty (partial completion — D-08).
 * Residual WIP cost is posted to Manufacturing Cost Variance (5060) by the service.
 * Audit fields (completedBy) injected from req.user — not accepted as input (T-F10-W3-04).
 */
export class CompleteProductionDto {
  @IsNumber()
  @Min(0)
  actualFinishedQty: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CompleteByProductDto)
  byProductsProduced?: CompleteByProductDto[];

  @IsOptional()
  @IsString()
  narration?: string;
}
