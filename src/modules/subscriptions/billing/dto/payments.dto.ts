import {
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class ListPaymentsQueryDto {
  @IsOptional()
  @IsIn([
    'created',
    'authorised',
    'captured',
    'failed',
    'refunded',
    'partially_refunded',
    'cancelled',
  ])
  status?: string;

  @IsOptional()
  @IsIn(['one_time', 'recurring'])
  paymentMode?: string;

  @IsOptional()
  @IsIn(['monthly', 'yearly', 'lifetime'])
  billingCycle?: string;

  @IsOptional()
  @IsMongoId()
  planId?: string;

  @IsOptional()
  @IsMongoId()
  subscriptionId?: string;

  /** Inclusive lower bound on `createdAt` (ISO 8601). */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Inclusive upper bound on `createdAt` (ISO 8601). */
  @IsOptional()
  @IsDateString()
  to?: string;

  /** Substring match on invoiceNumber (case-insensitive). */
  @IsOptional()
  @IsString()
  invoiceNumber?: string;

  /** When true, restrict to rows that have an `invoiceNumber` set. */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value === 'true' : Boolean(value),
  )
  hasInvoice?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  offset?: number;
}
