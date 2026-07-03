import { PartialType } from '@nestjs/mapped-types';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CreateSaleInvoiceDto } from './create-sale-invoice.dto';

export class UpdateSaleInvoiceDto extends PartialType(CreateSaleInvoiceDto) {
  // D21/R4 amendment path: when the old or new voucher date falls inside the firm's soft books-lock
  // window, an authorized editor may supply a reason to post the correction INTO the locked period
  // as an audited amendment (FyLockService records a `finance.period_amendment` event), instead of
  // globally unlocking + relocking the whole period. Ignored when the date is outside the lock.
  // Does NOT override a CLOSED fiscal year - that still requires an explicit reopen.
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  amendmentReason?: string;
}
