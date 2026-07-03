import { IsString, IsNumber, IsOptional, IsIn, Min } from 'class-validator';
import { Type } from 'class-transformer';

const VOUCHER_TYPES = [
  'sale_invoice', 'sale_order', 'proforma', 'delivery_challan',
  'credit_note', 'purchase_bill', 'purchase_order', 'grn',
  'debit_note', 'payment_in', 'payment_out', 'expense',
  'journal', 'manufacturing_voucher', 'job_work_in', 'job_work_out',
];

export class CreateVoucherSeriesDto {
  @IsIn(VOUCHER_TYPES)
  voucherType: string;

  @IsString()
  prefix: string;

  @IsOptional() @Type(() => Number) @IsNumber() @Min(1)
  startNumber?: number;

  @IsOptional() @Type(() => Number) @IsNumber() @Min(1)
  padDigits?: number;

  @IsString()
  financialYear: string;
}
