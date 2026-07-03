import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class EwbRequestDto {
  @IsOptional()
  @IsString()
  vehicleNo?: string;

  @IsOptional()
  @IsString()
  transporterId?: string;

  @IsOptional()
  @IsString()
  transporterName?: string;

  /**
   * Transport mode: 1=Road, 2=Rail, 3=Air, 4=Ship
   */
  @IsIn(['1', '2', '3', '4'])
  transMode: string;

  /**
   * Distance in km (required by NIC EWB API for validity period calculation)
   */
  @IsNumber()
  @Min(0)
  distance: number;
}
