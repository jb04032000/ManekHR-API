import { IsString, Matches } from 'class-validator';

export class PreviewDepreciationDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'runMonth must be in YYYY-MM format' })
  runMonth: string;
}
