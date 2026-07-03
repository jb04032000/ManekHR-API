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

export class CreditNoteLineDto {
  @IsOptional() @IsMongoId() itemId?: string;
  @IsOptional() @IsString() itemName?: string;
  @IsOptional() @IsString() hsnSacCode?: string;
  @IsOptional() @IsNumber() @Min(0) qty?: number;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsInt() @Min(0) ratePaise?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) discountPct?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(28) taxRate?: number;
  @IsOptional() @IsBoolean() reverseStock?: boolean;
}

export class CreateCreditNoteDto {
  @IsDateString() voucherDate: string;
  @IsMongoId() sourceInvoiceId: string;

  @IsIn(['goods_return', 'price_correction', 'post_sale_discount', 'deficiency', 'other'])
  cnType: string;

  @IsOptional()
  @IsIn([
    'sales_return',
    'post_sale_discount',
    'deficiency_in_services',
    'correction_in_invoice',
    'change_in_pos',
    'finalization_of_provisional_assessment',
    'others',
  ])
  reasonCode?: string;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CreditNoteLineDto)
  lineItems: CreditNoteLineDto[];

  @IsOptional() @IsString() narration?: string;
  @IsOptional() @IsString() notes?: string;

  @IsOptional()
  @IsIn(['pending', 'self_declared', 'ca_certified', 'not_applicable'])
  recipientItcReversalStatus?: string;

  @IsOptional() @IsString() recipientItcReversalDocUrl?: string;

  // Commercial / financial credit note (kasar-vatav): no GST adjustment when true (D11).
  @IsOptional() @IsBoolean() isCommercial?: boolean;
  // NOTE: cdnrType, isIntraState, partyId, partySnapshot, all paise totals, voucherNumber,
  // financialYear, state, refundAmountPaise are intentionally excluded — derived server-side
  // (T-F07W2-01, T-F07W2-02, T-F07W2-03).
}

export class UpdateCreditNoteDto {
  @IsOptional() @IsDateString() voucherDate?: string;

  @IsOptional()
  @IsIn(['goods_return', 'price_correction', 'post_sale_discount', 'deficiency', 'other'])
  cnType?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CreditNoteLineDto)
  lineItems?: CreditNoteLineDto[];

  @IsOptional() @IsString() narration?: string;
  @IsOptional() @IsString() notes?: string;

  @IsOptional()
  @IsIn(['pending', 'self_declared', 'ca_certified', 'not_applicable'])
  recipientItcReversalStatus?: string;

  @IsOptional() @IsString() recipientItcReversalDocUrl?: string;

  // Commercial / financial credit note (kasar-vatav): no GST adjustment when true (D11).
  @IsOptional() @IsBoolean() isCommercial?: boolean;
}

export class PostCreditNoteDto {
  // No body params — confirmation handled by route param only
}

export class CancelCreditNoteDto {
  @IsString() reason: string;
}

export class ListCreditNotesQueryDto {
  @IsOptional() @IsIn(['draft', 'posted', 'cancelled']) state?: string;
  // R10: filter the posting-quarantine bucket. 'needs_attention' = failed posts, 'clean' = rest.
  @IsOptional() @IsIn(['needs_attention', 'clean']) postingStatus?: string;
  @IsOptional() @IsMongoId() partyId?: string;
  @IsOptional() @IsDateString() fromDate?: string;
  @IsOptional() @IsDateString() toDate?: string;
  @IsOptional() @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsInt() @Min(0) skip?: number;
}
