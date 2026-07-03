import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class MvAdditionalCostInputDto {
  @IsMongoId()
  accountId: string;

  @IsNumber()
  @Min(0)
  amountPaise: number;

  @IsOptional()
  @IsString()
  narration?: string;
}

/**
 * Input for POST /manufacturing-vouchers — creates a draft MV.
 *
 * bomId resolves the BoM (service finds finishedItemId + bomVersionNo from BoM).
 * Components snapshot is built by the service from the resolved BoM.
 * Audit fields (createdBy) are injected from req.user — not accepted as input (T-F10-W3-04).
 */
export class CreateManufacturingVoucherDto {
  @IsMongoId()
  bomId: string;

  @IsDateString()
  voucherDate: string;

  @IsNumber()
  @Min(0)
  finishedQty: number;

  @IsMongoId()
  finishedGodownId: string;

  @IsOptional()
  @IsString()
  batchNo?: string;

  /**
   * Costing mode: 'actual' (default) or 'standard' — D-05.
   * Service defaults to 'actual' if not supplied.
   */
  @IsOptional()
  @IsIn(['actual', 'standard'])
  costMethod?: 'actual' | 'standard';

  /**
   * Explode sub-assemblies toggle — D-04.
   * false (default): MV consumes immediate components only; sub-assembly MVs must exist.
   * true: MV consumes leaf-level raw materials directly via BomService.explode().
   */
  @IsOptional()
  @IsBoolean()
  explodeSubAssemblies?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MvAdditionalCostInputDto)
  additionalCosts?: MvAdditionalCostInputDto[];

  @IsOptional()
  @IsString()
  narration?: string;
}
