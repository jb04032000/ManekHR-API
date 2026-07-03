import { IsOptional, IsString, IsIn, ValidateNested, MinLength, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class IrpConfigDto {
  @IsIn(['gsp_surepass', 'nic_direct'])
  mode: 'gsp_surepass' | 'nic_direct';

  @IsOptional()
  @IsString()
  gspKey?: string;

  @IsOptional()
  @IsString()
  username?: string;

  // WR-08: length bounds prevent oversized ciphertext in encrypted credential field
  // and guard against excessively long strings hitting IRP/EWB portal limits.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  password?: string;
}

export class EwbConfigDto {
  @IsIn(['gsp_surepass', 'nic_direct'])
  mode: 'gsp_surepass' | 'nic_direct';

  @IsOptional()
  @IsString()
  gspKey?: string;

  @IsOptional()
  @IsString()
  username?: string;

  // WR-08: length bounds prevent oversized ciphertext in encrypted credential field
  // and guard against excessively long strings hitting IRP/EWB portal limits.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  password?: string;
}

export class UpdateGstConfigDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => IrpConfigDto)
  irpConfig?: IrpConfigDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => EwbConfigDto)
  ewbConfig?: EwbConfigDto;
}
