import {
  IsString,
  IsNumber,
  IsDate,
  IsMongoId,
  IsOptional,
  IsArray,
  ValidateNested,
  IsNotEmpty,
  Min,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class JwiLineDto {
  @IsString()
  @IsNotEmpty()
  itemDescription: string;

  @IsOptional()
  @IsString()
  hsnCode?: string;

  @IsNumber()
  @Min(0.001)
  qty: number;

  @IsString()
  @IsNotEmpty()
  unit: string;

  @IsOptional()
  @IsString()
  vehicleNo?: string;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  karigarIds?: string[];

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  machineIds?: string[];

  @IsOptional()
  @IsString()
  narration?: string;
}

export class CreateJwInwardDto {
  @Type(() => Date)
  @IsDate()
  voucherDate: Date;

  @IsMongoId()
  partyId: string;

  @IsOptional()
  @IsString()
  vehicleNo?: string;

  @IsOptional()
  @IsString()
  transporterName?: string;

  @IsOptional()
  @IsString()
  transporterGSTIN?: string;

  @IsOptional()
  @IsString()
  lrNo?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => JwiLineDto)
  lines: JwiLineDto[];

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  karigarIds?: string[];

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  machineIds?: string[];

  @IsOptional()
  @IsMongoId()
  shiftId?: string;

  @IsOptional()
  @IsString()
  narration?: string;
}
