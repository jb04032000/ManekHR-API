import { IsOptional, IsEnum } from 'class-validator';

export class ListLoanAccountsDto {
  @IsOptional()
  @IsEnum(['active', 'closed', 'npa'])
  status?: string;

  @IsOptional()
  @IsEnum(['term_loan', 'overdraft', 'cash_credit'])
  loanType?: string;
}
