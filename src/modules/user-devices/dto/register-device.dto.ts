import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDeviceDto {
  @IsString()
  @MinLength(10)
  @MaxLength(4096)
  fcmToken: string;

  @IsEnum(['ios', 'android', 'web'])
  platform: 'ios' | 'android' | 'web';

  @IsString()
  @IsOptional()
  @MaxLength(120)
  deviceName?: string;

  @IsString()
  @IsOptional()
  @MaxLength(40)
  appVersion?: string;
}
