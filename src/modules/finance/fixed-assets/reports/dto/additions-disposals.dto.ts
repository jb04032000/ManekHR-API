import { IsDateString } from 'class-validator';

export class AdditionsDisposalsDto {
  @IsDateString() fromDate: string;
  @IsDateString() toDate: string;
}
