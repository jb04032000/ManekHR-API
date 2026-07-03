import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class DebitNoteLineDto {
  @IsOptional() @IsMongoId() itemId?: string;
  @IsOptional() @IsString() itemName?: string;
  @IsOptional() @IsString() hsnSacCode?: string;
  @IsOptional() @IsNumber() @Min(0) qty?: number;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsInt() @Min(0) ratePaise?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(28) taxRate?: number;
  // NOTE: isCapitalGoods is NOT in DTO — copied from sourceBill server-side (T-F07W3-01)
}

export class CreateDebitNoteDto {
  @IsDateString() voucherDate: string;
  @IsMongoId() sourceBillId: string;
  @IsOptional() @IsMongoId() sourceGrnReturnId?: string;
  @IsOptional() @IsString() vendorBillRef?: string;

  @IsIn(['goods_return', 'price_correction', 'excess_billing', 'quality_rejection', 'other'])
  dnType: string;

  @IsOptional() @IsBoolean() vendorAccepted?: boolean;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => DebitNoteLineDto)
  lineItems: DebitNoteLineDto[];

  @IsOptional() @IsString() narration?: string;
}

export class UpdateDebitNoteDto {
  @IsOptional() @IsDateString() voucherDate?: string;
  @IsOptional() @IsString() vendorBillRef?: string;
  @IsOptional()
  @IsIn(['goods_return', 'price_correction', 'excess_billing', 'quality_rejection', 'other'])
  dnType?: string;
  @IsOptional() @IsBoolean() vendorAccepted?: boolean;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => DebitNoteLineDto)
  lineItems?: DebitNoteLineDto[];
  @IsOptional() @IsString() narration?: string;
}

export class CancelDebitNoteDto {
  @IsString() reason: string;
}

export class ListDebitNotesQueryDto {
  @IsOptional() @IsIn(['draft', 'posted', 'cancelled']) state?: string;
  @IsOptional() @IsMongoId() partyId?: string;
  @IsOptional() @IsDateString() fromDate?: string;
  @IsOptional() @IsDateString() toDate?: string;
  @IsOptional() @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsInt() @Min(0) skip?: number;
  // R10: quarantine list filter — 'needs_attention' or 'clean' (mirrors SaleInvoice list).
  @IsOptional() @IsIn(['needs_attention', 'clean']) postingStatus?: string;
}
