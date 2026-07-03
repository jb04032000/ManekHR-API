import { IsBoolean, IsEnum, IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateKarigarProfileDto {
  @IsBoolean()
  isKarigar: boolean;

  @IsOptional()
  @IsEnum(['zari', 'embroidery', 'print', 'dyeing', 'cutting', 'finishing', 'other'])
  karigarSkillType?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  karigarDailyRatePaise?: number;
}
