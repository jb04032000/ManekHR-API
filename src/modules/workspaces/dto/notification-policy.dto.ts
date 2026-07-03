import { Type } from 'class-transformer';
import { IsBoolean, IsObject, IsOptional, ValidateNested } from 'class-validator';

class PermissionChangeChannelsDto {
  @IsBoolean()
  @IsOptional()
  inApp?: boolean;

  @IsBoolean()
  @IsOptional()
  email?: boolean;

  @IsBoolean()
  @IsOptional()
  sms?: boolean;
}

class PermissionChangesDto {
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => PermissionChangeChannelsDto)
  channels?: PermissionChangeChannelsDto;
}

export class UpdateNotificationPolicyDto {
  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => PermissionChangesDto)
  permissionChanges?: PermissionChangesDto;
}
