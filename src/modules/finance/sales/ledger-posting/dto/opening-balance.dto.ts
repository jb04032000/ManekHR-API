import { IsInt, Min, IsIn, IsDateString } from 'class-validator';

// Body for PATCH .../accounts/:accountId/opening-balance.
// amountPaise: absolute opening amount in paise (>= 0; 0 clears the opening balance).
// drOrCr: the side of the ACCOUNT line (server posts the 3004 contra on the other side).
// asOfDate: the date the opening balance is effective (typically the books-begin date).
export class SetOpeningBalanceDto {
  @IsInt()
  @Min(0)
  amountPaise: number;

  @IsIn(['debit', 'credit'])
  drOrCr: 'debit' | 'credit';

  @IsDateString()
  asOfDate: string;
}
