import { IsString, IsIn, IsOptional, IsBoolean, IsNumber, IsEmail, Matches } from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePartyDto {
  @IsString() name: string;
  @IsIn(['customer', 'vendor', 'broker', 'transporter', 'employee_advance']) partyType: string;
  @IsOptional() @IsBoolean() isInformal?: boolean;
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, { message: 'Invalid GSTIN' })
  gstin?: string;
  @IsOptional() @IsString() pan?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @Type(() => Number) @IsNumber() creditTermsDays?: number;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() address?: string;
}
