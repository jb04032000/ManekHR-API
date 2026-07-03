import {
  IsArray,
  IsBoolean,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateReminderSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^([01]?\d|2[0-3]):[0-5]\d$/, {
    message: 'dispatchTime must be in HH:MM format (00:00–23:59)',
  })
  dispatchTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  fromName?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  minimumOutstandingPaise?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  maxRemindersPerDay?: number;

  @IsOptional()
  @IsBoolean()
  defaultChannelInApp?: boolean;

  @IsOptional()
  @IsBoolean()
  defaultChannelEmail?: boolean;

  @IsOptional()
  @IsBoolean()
  defaultChannelSms?: boolean;

  @IsOptional()
  @IsBoolean()
  defaultChannelPush?: boolean;

  @IsOptional()
  @IsBoolean()
  defaultChannelWhatsApp?: boolean;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  optOutPartyIds?: string[];
}
