import {
  IsString,
  IsDate,
  IsNumber,
  IsArray,
  IsOptional,
  Min,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

export class POLineItemDto {
  @IsOptional() @IsString() itemId?: string;
  @IsString() itemName: string;
  @IsOptional() @IsString() hsnSacCode?: string;
  @IsNumber() @Min(0) qty: number;
  @IsOptional() @IsString() unit?: string;
  @IsNumber() @Min(0) ratePaise: number;
  @IsOptional() @IsNumber() @Min(0) discountPct?: number;
  @IsOptional() @IsNumber() @Min(0) taxRate?: number;
  @IsNumber() @Min(0) lineTotalPaise: number;
  @IsOptional() @IsBoolean() isCapitalGoods?: boolean;
}

export class CreatePurchaseOrderDto {
  @Type(() => Date) @IsDate() voucherDate: Date;
  @IsString() financialYear: string;
  @IsOptional() @IsString() partyId?: string;
  @IsOptional() partySnapshot?: Record<string, any>;
  @IsOptional() @IsString() placeOfSupplyStateCode?: string;
  @IsOptional() @Type(() => Date) @IsDate() expectedDeliveryDate?: Date;
  @IsArray() @ValidateNested({ each: true }) @Type(() => POLineItemDto)
  lineItems: POLineItemDto[];
  @IsNumber() @Min(0) taxableValuePaise: number;
  @IsOptional() @IsNumber() @Min(0) cgstPaise?: number;
  @IsOptional() @IsNumber() @Min(0) sgstPaise?: number;
  @IsOptional() @IsNumber() @Min(0) igstPaise?: number;
  @IsNumber() @Min(1) grandTotalPaise: number;
  @IsOptional() @IsString() notes?: string;
}
