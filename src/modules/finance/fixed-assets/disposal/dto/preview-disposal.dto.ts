import { IsDateString, IsNumber, Min } from 'class-validator';

export class PreviewDisposalDto {
  @IsDateString()
  disposalDate: string;

  @IsNumber()
  @Min(0)
  disposalProceedsPaise: number;
}
