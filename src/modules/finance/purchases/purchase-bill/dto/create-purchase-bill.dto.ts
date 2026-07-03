import {
  IsString,
  IsDate,
  IsNumber,
  IsArray,
  IsOptional,
  Min,
  ValidateNested,
  IsBoolean,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PBLineItemDto {
  @IsOptional() @IsString() itemId?: string;
  @IsOptional() @IsString() itemName?: string;
  @IsOptional() @IsString() hsnSacCode?: string;
  @IsOptional() @IsNumber() @Min(0) qty?: number;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsNumber() @Min(0) ratePaise?: number;
  @IsOptional() @IsNumber() @Min(0) discountPct?: number;
  @IsOptional() @IsNumber() @Min(0) taxRate?: number;
  @IsOptional() @IsNumber() @Min(0) taxableValuePaise?: number;
  @IsOptional() @IsNumber() @Min(0) cgstPaise?: number;
  @IsOptional() @IsNumber() @Min(0) sgstPaise?: number;
  @IsOptional() @IsNumber() @Min(0) igstPaise?: number;
  @IsOptional() @IsNumber() @Min(0) lineTotalPaise?: number;
  /** When true: ITC deferred to 1103 Capital Goods ITC; released monthly over 60 months */
  @IsOptional() @IsBoolean() isCapitalGoods?: boolean;
}

export class CreatePurchaseBillDto {
  @Type(() => Date) @IsDate() voucherDate: Date;
  @IsString() financialYear: string;
  @IsOptional() @IsString() partyId?: string;
  @IsOptional() partySnapshot?: Record<string, any>;
  @IsOptional() @IsString() placeOfSupplyStateCode?: string;
  @IsOptional() @IsBoolean() isReverseCharge?: boolean;
  @IsOptional() @IsString() vendorBillNumber?: string;
  @IsOptional() @Type(() => Date) @IsDate() vendorBillDate?: Date;
  @IsOptional() @IsString() sourcePoId?: string;
  @IsOptional() @IsString() sourcePoNumber?: string;
  @IsOptional() @IsString() sourceGrnId?: string;
  @IsOptional() @IsString() sourceGrnNumber?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PBLineItemDto)
  lineItems: PBLineItemDto[];
  @IsNumber() @Min(0) taxableValuePaise: number;
  @IsOptional() @IsNumber() @Min(0) cgstPaise?: number;
  @IsOptional() @IsNumber() @Min(0) sgstPaise?: number;
  @IsOptional() @IsNumber() @Min(0) igstPaise?: number;
  @IsNumber() @Min(1) grandTotalPaise: number;
  @IsOptional() @IsString() ocrSourceFileUrl?: string;
  @IsOptional() @IsNumber() ocrConfidence?: number;
}
