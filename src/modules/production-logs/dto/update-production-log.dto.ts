import {
  IsOptional,
  IsString,
  IsInt,
  IsNumber,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateProductionLogDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  @Type(() => Number)
  stitchCount?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  @Type(() => Number)
  pieceCount?: number | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(24)
  @Type(() => Number)
  hoursLogged?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
