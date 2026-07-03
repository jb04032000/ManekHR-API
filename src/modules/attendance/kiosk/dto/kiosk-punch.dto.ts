import { IsString, Matches, IsMongoId } from 'class-validator';

export class KioskPunchDto {
  @IsMongoId()
  wsId: string;

  @IsString()
  secret: string;

  @IsString()
  employeeCode: string;

  @IsString()
  @Matches(/^\d{4}$/, { message: 'PIN must be exactly 4 digits' })
  pin: string;
}

export class KioskLookupDto {
  @IsMongoId()
  wsId: string;

  @IsString()
  secret: string;

  @IsString()
  employeeCode: string;
}
