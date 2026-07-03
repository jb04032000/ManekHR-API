import { IsOptional, IsEnum, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';

export class ListBankAccountsDto {
  @IsOptional()
  @IsEnum(['current', 'savings', 'overdraft', 'cash_credit'])
  accountType?: string;

  /** Filter to only return active (not deleted) accounts — defaults to true */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  activeOnly?: boolean;
}
