import {
  IsBoolean,
  IsISO8601,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class CloseFyDto {
  @IsMongoId()
  fyId: string;

  /** Defaults to fy.endDate when omitted (D-13). */
  @IsISO8601()
  effectiveCloseDate: string;

  /** Must match firm.legalName / firmName verbatim (case-sensitive). */
  @IsString()
  @IsNotEmpty()
  firmNameConfirmation: string;

  /** false (default) = block on failed health checks; true = warn-only. */
  @IsBoolean()
  @IsOptional()
  skipHealthChecks?: boolean;
}
