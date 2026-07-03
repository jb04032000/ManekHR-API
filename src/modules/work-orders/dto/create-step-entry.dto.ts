import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';

/**
 * CreateStepEntryDto — body for
 * `POST /workspaces/:wsId/machines/work-orders/:orderId/steps/:stepId/entries`.
 * `byUserId` + `at` are server-set from the JWT — never client-supplied.
 * Non-null `progress` overwrites step.progress (manual progress log).
 */
export class CreateStepEntryDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  qty?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  @Max(100)
  @Type(() => Number)
  progress?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
