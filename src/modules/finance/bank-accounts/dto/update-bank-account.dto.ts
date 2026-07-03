import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
} from 'class-validator';

export class UpdateBankAccountDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  bankName?: string;

  /** Updating account number — full value accepted; masking applied on response */
  @IsOptional()
  @IsString()
  accountNumber?: string;

  @IsOptional()
  @IsString()
  ifscCode?: string;

  @IsOptional()
  @IsEnum(['current', 'savings', 'overdraft', 'cash_credit'])
  accountType?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsString()
  upiId?: string;
}
