import { IsOptional, IsMongoId, IsEnum, IsNumber, IsDate, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListJwInvoiceDto {
  @IsOptional()
  @IsMongoId()
  partyId?: string;

  @IsOptional()
  @IsEnum(['draft', 'posted', 'cancelled'])
  status?: 'draft' | 'posted' | 'cancelled';

  @IsOptional()
  @IsEnum(['unpaid', 'partial', 'paid'])
  paymentStatus?: 'unpaid' | 'partial' | 'paid';

  // R10: filter the posting-quarantine bucket. 'needs_attention' = failed-post drafts,
  // 'clean' = everything not flagged. Mirrors SaleInvoice (D23).
  @IsOptional()
  @IsEnum(['needs_attention', 'clean'])
  postingStatus?: 'needs_attention' | 'clean';

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  dateFrom?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  dateTo?: Date;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  pageSize?: number;
}
