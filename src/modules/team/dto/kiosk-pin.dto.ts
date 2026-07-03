import { IsString, Matches } from 'class-validator';

export class SetKioskPinDto {
  @IsString()
  @Matches(/^\d{4}$/, { message: 'PIN must be exactly 4 digits' })
  pin: string;
}
