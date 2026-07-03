import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsNumber,
  IsBoolean,
  IsOptional,
  IsDateString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateChequeDto {
  @IsEnum(['issued', 'received'])
  chequeType: string;

  @IsString()
  @IsNotEmpty()
  chequeNumber: string;

  /**
   * Actual date printed on the cheque.
   * If chequeDate > today → isPostDated = true (auto-detected server-side).
   */
  @IsDateString()
  chequeDate: string;

  @IsString()
  @IsNotEmpty()
  bankAccountId: string;

  /**
   * Amount in paise — must be a positive integer.
   * T-F06W4: Math.floor check enforced server-side.
   */
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  amount: number;

  @IsOptional()
  @IsString()
  partyId?: string;

  @IsOptional()
  @IsString()
  partyName?: string;

  /** Reference to the payment voucher that issued/received this cheque */
  @IsOptional()
  @IsString()
  paymentVoucherId?: string;

  @IsOptional()
  @IsString()
  paymentVoucherNumber?: string;

  @IsOptional()
  @IsString()
  narration?: string;
}
