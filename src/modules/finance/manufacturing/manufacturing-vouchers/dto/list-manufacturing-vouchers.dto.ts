import { IsDateString, IsIn, IsMongoId, IsOptional } from 'class-validator';

/**
 * Query parameters for GET /manufacturing-vouchers — filter and list MVs.
 *
 * All fields are optional; service applies only supplied filters.
 * Dates are ISO strings; service converts to Date via new Date(...) for range queries.
 */
export class ListManufacturingVouchersDto {
  /** Filter by lifecycle status (D-03) */
  @IsOptional()
  @IsIn(['draft', 'in_progress', 'completed', 'cancelled'])
  status?: 'draft' | 'in_progress' | 'completed' | 'cancelled';

  /** Filter by finished item ID */
  @IsOptional()
  @IsMongoId()
  itemId?: string;

  /** From date (inclusive) for voucherDate range */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** To date (inclusive) for voucherDate range */
  @IsOptional()
  @IsDateString()
  to?: string;
}
