/**
 * DTOs for the Bonus module (Phase 3A).
 *
 * Vocabulary (binding - phase-3-clarity-and-overview.md):
 *   "Statutory Bonus" = legally required; engine applies eligibility + calc-wage + percent
 *   "Festival/Discretionary Bonus" = free-form employer grant; no statutory engine
 *
 * BonusService methods that consume these DTOs:
 *   previewStatutoryBonus  -> PreviewStatutoryBonusDto
 *   runStatutoryBonus      -> RunStatutoryBonusDto
 *   recordFestivalBonus    -> RecordFestivalBonusDto
 *   getBonusSummary        -> BonusSummaryQueryDto
 */

import {
  IsArray,
  IsBoolean,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

// ---------------------------------------------------------------------------
// Preview statutory bonus (read-only; no writes)
// ---------------------------------------------------------------------------

export class PreviewStatutoryBonusDto {
  /**
   * Financial year start year. E.g. 2025 = FY 2025-26 (April 2025 - March 2026).
   */
  @IsInt()
  @Min(2000)
  financialYear: number;

  /**
   * Optional: restrict preview to a single member. Omit for all workspace members.
   */
  @IsMongoId()
  @IsOptional()
  teamMemberId?: string;

  /**
   * Disbursement month for the bonus (used to derive the salary record target).
   * Default: current month when not provided.
   */
  @IsInt()
  @Min(1)
  @Max(12)
  @IsOptional()
  disbursedMonth?: number;

  @IsInt()
  @Min(2000)
  @IsOptional()
  disbursedYear?: number;
}

// ---------------------------------------------------------------------------
// Run statutory bonus (creates SalaryAdjustment rows + BonusRun)
// ---------------------------------------------------------------------------

export class RunStatutoryBonusDto {
  /**
   * Financial year start year (e.g. 2025 for FY 2025-26).
   */
  @IsInt()
  @Min(2000)
  financialYear: number;

  /**
   * Month + year to post the bonus SalaryAdjustment into.
   * Typically November (payable by Nov 30 for Apr-Mar FY).
   */
  @IsInt()
  @Min(1)
  @Max(12)
  disbursedMonth: number;

  @IsInt()
  @Min(2000)
  disbursedYear: number;

  /**
   * Optional: restrict run to specific members. Omit for all eligible members.
   */
  @IsArray()
  @IsMongoId({ each: true })
  @IsOptional()
  teamMemberIds?: string[];

  @IsString()
  @IsOptional()
  note?: string;
}

// ---------------------------------------------------------------------------
// Record festival / discretionary bonus
// ---------------------------------------------------------------------------

/** One entry in a festival bonus batch. */
export class FestivalBonusEntryDto {
  @IsMongoId()
  @IsNotEmpty()
  teamMemberId: string;

  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsString()
  @IsOptional()
  note?: string;
}

export class RecordFestivalBonusDto {
  /**
   * Free-form sub-type label. E.g. 'festival_diwali', 'performance', 'referral'.
   * Stored on the BonusRun subType field and as part of the SalaryAdjustment reasonTitle.
   */
  @IsString()
  @IsNotEmpty()
  subType: string;

  /**
   * Financial year this bonus is attributed to. Used for F&F clawback queries
   * and for the countsAsStatutory double-obligation guard.
   */
  @IsInt()
  @Min(2000)
  financialYear: number;

  /**
   * Month + year to post the bonus SalaryAdjustment into.
   */
  @IsInt()
  @Min(1)
  @Max(12)
  disbursedMonth: number;

  @IsInt()
  @Min(2000)
  disbursedYear: number;

  /**
   * When true, this festival bonus also satisfies the statutory obligation for
   * each member it covers (up to the statutory amount). The statutory run for
   * the same FY will treat these members as already paid and will not double-post.
   * See BonusService.runStatutoryBonus for the double-obligation avoidance logic.
   */
  @IsBoolean()
  @IsOptional()
  countsAsStatutory?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => FestivalBonusEntryDto)
  entries: FestivalBonusEntryDto[];

  @IsString()
  @IsOptional()
  note?: string;
}

// ---------------------------------------------------------------------------
// Bonus summary query
// ---------------------------------------------------------------------------

export class BonusSummaryQueryDto {
  /**
   * Financial year start year. Required.
   */
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  financialYear: number;

  @IsMongoId()
  @IsOptional()
  teamMemberId?: string;

  /**
   * Filter by bonus type. Omit to return both statutory and discretionary.
   */
  @IsString()
  @IsOptional()
  bonusType?: 'statutory' | 'discretionary';
}

// ---------------------------------------------------------------------------
// Update bonus config
// ---------------------------------------------------------------------------

export class UpdateBonusConfigDto {
  @IsNumber()
  @Min(1)
  @IsOptional()
  eligibilityWageCeiling?: number;

  @IsNumber()
  @Min(1)
  @IsOptional()
  calculationWageFloor?: number;

  @IsNumber()
  @Min(8.33)
  @Max(20)
  @IsOptional()
  minPercent?: number;

  @IsNumber()
  @Min(8.33)
  @Max(20)
  @IsOptional()
  maxPercent?: number;

  @IsNumber()
  @Min(8.33)
  @Max(20)
  @IsOptional()
  defaultPercent?: number;

  @IsNumber()
  @Min(0)
  @Max(20)
  @IsOptional()
  allocableSurplusPercent?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  clawbackMonthsDefault?: number;

  @IsBoolean()
  @IsOptional()
  newEstablishment?: boolean;
}
