import {
  IsString,
  IsOptional,
  IsDateString,
  IsNumber,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO for transitioning cheque to 'in_transit' (deposit action).
 * Marks a received cheque as deposited to the bank — awaiting clearing.
 */
export class DepositChequeDto {
  @IsDateString()
  depositDate: string;
}

/**
 * DTO for transitioning cheque to 'cleared' (clearing action).
 * For issued cheques: debits bank account.
 * For received cheques (already in_transit): credits bank account.
 */
export class ClearChequeDto {
  @IsDateString()
  clearingDate: string;
}

/**
 * DTO for transitioning cheque to 'bounced'.
 * Posts bounce charges to Ledger: Dr 5014 Cheque Bounce Charges / Cr Bank.
 */
export class BounceChequeDto {
  @IsDateString()
  bounceDate: string;

  @IsOptional()
  @IsString()
  bounceReason?: string;

  /**
   * Bank-imposed bounce charges in paise.
   * Posts: Dr 5014 Cheque Bounce Charges / Cr Bank Account
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  bounceChargesPaise?: number;
}

/**
 * DTO for transitioning cheque to 'stopped' (stop payment).
 */
export class StopChequePaidDto {
  @IsDateString()
  stopPaymentDate: string;

  @IsOptional()
  @IsString()
  stopPaymentNarration?: string;
}
