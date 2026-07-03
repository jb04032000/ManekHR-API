import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * CreateWorkOrderDto — body for
 * `POST /workspaces/:wsId/machines/work-orders` (Shop Floor "New Order").
 * `code` is server-generated (WO-NNN) — never client-supplied.
 */
export class CreateWorkOrderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  partyName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  productType?: string;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  qty!: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  ratePerUnit!: number;

  // Hex chip colour; server defaults '#F0A030' when absent.
  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  colorHex?: string;
}
