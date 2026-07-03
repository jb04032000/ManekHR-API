import {
  ArrayMinSize,
  IsArray,
  IsDate,
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class JwoReturnLineDto {
  @IsMongoId()
  jobWorkLotId: string;

  @IsString()
  @IsNotEmpty()
  lotNo: string;

  @IsString()
  @IsNotEmpty()
  itemDescription: string;

  @IsNumber()
  @Min(0.001)
  qtyReturning: number;

  @IsString()
  @IsNotEmpty()
  unit: string;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  karigarIds?: string[];

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  machineIds?: string[];
}

class JwoWastageLineDto {
  @IsMongoId()
  jobWorkLotId: string;

  @IsString()
  @IsNotEmpty()
  itemDescription: string;

  @IsNumber()
  @Min(0.001)
  qtyWasted: number;

  @IsString()
  @IsNotEmpty()
  unit: string;

  @IsEnum([
    'cutting',
    'breakage',
    'color_damage',
    'machine_fault',
    'design_rework',
    'shrinkage',
    'other',
  ])
  reasonCode: string;

  @IsOptional()
  @IsString()
  narration?: string;
}

export class CreateJwOutwardDto {
  @Type(() => Date)
  @IsDate()
  voucherDate: Date;

  @IsMongoId()
  partyId: string;

  @IsOptional()
  @IsString()
  vehicleNo?: string;

  @IsOptional()
  @IsString()
  transporterName?: string;

  @IsOptional()
  @IsString()
  transporterGSTIN?: string;

  @IsOptional()
  @IsString()
  lrNo?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JwoReturnLineDto)
  @ArrayMinSize(1)
  returnLines: JwoReturnLineDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JwoWastageLineDto)
  wastageLines?: JwoWastageLineDto[];

  /** D-17: karigar attribution is mandatory on JWO (at least 1 karigar required) */
  @IsArray()
  @IsMongoId({ each: true })
  @ArrayMinSize(1)
  karigarIds: string[];

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  machineIds?: string[];

  @IsOptional()
  @IsMongoId()
  shiftId?: string;

  @IsOptional()
  @IsString()
  narration?: string;

  /**
   * Optional manual override for place of supply.
   * If absent, service falls back to party.gstin[0:2] → firm.gstin[0:2] at post time.
   */
  @IsOptional()
  @IsString()
  placeOfSupplyStateCode?: string;
}
