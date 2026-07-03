import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsNumber,
  IsBoolean,
  IsDateString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateBankAccountDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  bankName: string;

  /** Account number stored plain in DB; masked to last-4 on response (T-F06W1-03) */
  @IsOptional()
  @IsString()
  accountNumber?: string;

  @IsOptional()
  @IsString()
  ifscCode?: string;

  @IsEnum(['current', 'savings', 'overdraft', 'cash_credit'])
  accountType: string;

  /**
   * Opening balance in paise.
   * Must be a whole number (no sub-paisa fractional amounts).
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  openingBalancePaise?: number;

  @IsOptional()
  @IsDateString()
  openingBalanceDate?: string;

  /**
   * CoA sub-account code under group 1002 (Bank Accounts).
   * Caller is responsible for creating the Account document first
   * via the Accounts API before registering the bank account.
   */
  @IsString()
  @IsNotEmpty()
  coaAccountCode: string;

  /**
   * ObjectId of the Account document that represents this bank account
   * in the Chart of Accounts.
   */
  @IsString()
  @IsNotEmpty()
  coaAccountId: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsString()
  upiId?: string;
}
