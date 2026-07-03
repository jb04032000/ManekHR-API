import { IsBoolean, IsArray, IsString, ArrayMaxSize, IsOptional } from 'class-validator';

export class UpdateKioskSettingsDto {
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @IsOptional()
  allowedIpRanges?: string[];
}
