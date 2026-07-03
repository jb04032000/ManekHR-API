import {
  IsString, IsNotEmpty, IsOptional, IsMongoId, IsBoolean,
} from 'class-validator';

export class CreateDeviceDto {
  @IsString() @IsNotEmpty() serial: string;
  @IsString() @IsOptional() alias?: string;
  @IsString() @IsOptional() vendor?: string;
}

export class UpdateDeviceDto {
  @IsString() @IsOptional() alias?: string;
  @IsString() @IsOptional() vendor?: string;
  @IsString() @IsOptional() firmwareVersion?: string;
}

export class RotateIngestTokenDto {
  @IsBoolean() @IsNotEmpty() confirm: boolean;
}

export class AssignDeviceUserDto {
  @IsString() @IsNotEmpty() deviceSerial: string;
  @IsString() @IsNotEmpty() deviceUserId: string;
  @IsMongoId() @IsNotEmpty() teamMemberId: string;
}
