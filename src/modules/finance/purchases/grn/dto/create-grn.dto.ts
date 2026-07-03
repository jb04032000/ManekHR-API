import { IsString, IsDate, IsArray, IsOptional, ValidateNested, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class GrnLineItemDto {
  @IsOptional() @IsString() itemId?: string;
  @IsOptional() @IsString() itemName?: string;
  @IsOptional() @IsNumber() @Min(0) qtyOrdered?: number;
  @IsOptional() @IsNumber() @Min(0) qtyReceived?: number;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsNumber() @Min(0) ratePaise?: number;
  @IsOptional() @IsString() batchNumber?: string;
  @IsOptional() @IsString() notes?: string;
}

export class CreateGrnDto {
  @Type(() => Date) @IsDate() voucherDate: Date;
  @IsString() financialYear: string;
  @IsOptional() @IsString() partyId?: string;
  @IsOptional() partySnapshot?: Record<string, any>;
  @IsOptional() @IsString() sourcePoId?: string;
  @IsOptional() @IsString() sourcePoNumber?: string;
  @IsOptional() @IsString() vendorDeliveryNoteNumber?: string;
  @IsOptional() @Type(() => Date) @IsDate() vendorDeliveryNoteDate?: Date;
  @IsArray() @ValidateNested({ each: true }) @Type(() => GrnLineItemDto)
  lineItems: GrnLineItemDto[];
  @IsOptional() @IsString() notes?: string;
}
