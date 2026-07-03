import { IsEnum, IsString, Matches } from 'class-validator';

export class ManualRunDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'runMonth must be in YYYY-MM format' })
  runMonth: string;

  @IsEnum(['monthly', 'quarterly', 'manual'], { message: 'runType must be monthly, quarterly, or manual' })
  runType: 'monthly' | 'quarterly' | 'manual';
}
