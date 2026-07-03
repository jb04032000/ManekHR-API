import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsMongoId,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class LineItemDto {
  @IsMongoId()
  itemId: string;

  @IsString()
  itemName: string;

  @IsOptional()
  @IsString()
  hsnSacCode?: string;

  @IsNumber()
  @Min(0)
  qty: number;

  @IsString()
  unit: string;

  @IsNumber()
  @Min(0)
  ratePaise: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPct?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discountFlatPaise?: number;

  @IsIn([0, 5, 12, 18, 28])
  taxRate: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cessRate?: number;

  @IsOptional()
  @IsBoolean()
  isTaxInclusive?: boolean;
}

export class CreateQuotationDto {
  @IsMongoId()
  partyId: string;

  @IsDateString()
  voucherDate: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LineItemDto)
  lineItems: LineItemDto[];

  @IsOptional()
  @IsString()
  placeOfSupplyStateCode?: string;

  @IsOptional()
  @IsObject()
  paymentTerms?: { dueDays?: number; label?: string };

  @IsOptional()
  @IsArray()
  additionalCharges?: any[];

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  internalNotes?: string;

  @IsOptional()
  @IsDateString()
  validUntilDate?: string;
}
