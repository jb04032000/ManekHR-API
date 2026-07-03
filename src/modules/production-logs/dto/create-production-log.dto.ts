import {
  IsMongoId,
  IsOptional,
  IsString,
  IsInt,
  IsNumber,
  Min,
  Max,
  MaxLength,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProductionLogDto {
  // assignmentId optional — backend auto-resolves from (machineId, date, teamMemberId)
  // when exactly one active assignment matches; else throws ASSIGNMENT_AMBIGUOUS (D-06).
  @IsOptional()
  @IsMongoId()
  assignmentId?: string;

  // For bulk endpoint, machineId is in body. For single-log endpoint, machineId
  // comes from URL path; this body field should be ignored by the controller in
  // that case but is accepted for shape consistency with bulk.
  @IsOptional()
  @IsMongoId()
  machineId?: string;

  @IsMongoId()
  teamMemberId!: string;

  @IsOptional()
  @IsMongoId()
  shiftId?: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  @Type(() => Number)
  stitchCount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  @Type(() => Number)
  pieceCount?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(24)
  @Type(() => Number)
  hoursLogged?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
