import { IsString, IsNumber, IsDateString, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO for recording the actual disbursement of loan funds to the bank account.
 * Posts: Dr bankCoaCode / Cr coaLiabilityAccountCode
 */
export class RecordDisbursementDto {
  /**
   * Bank account CoA code (e.g. '1002' for generic bank or sub-account code)
   * that received the disbursed funds.
   */
  @IsString()
  bankCoaCode: string;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  amountPaise: number;

  @IsDateString()
  disbursementDate: string;

  @IsOptional()
  @IsString()
  narration?: string;
}
