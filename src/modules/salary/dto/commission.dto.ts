/**
 * DTOs for the Commission / Incentive module (Phase 3B).
 *
 * recordCommissionEntries: bulk-capable create - one call posts commission or
 *   incentive SalaryAdjustment rows for one or many members in a period.
 * CommissionYtdQueryDto: year-to-date query params.
 * ListCommissionEntriesQueryDto: list query for period/member filter.
 * CreateCommissionScheduleDto: create a recurring schedule rule.
 * UpdateCommissionScheduleDto: patch amount/dates/note/status.
 * DisburseScheduleDto: manually trigger disbursement for a due period.
 */

import {
  IsArray,
  IsEnum,
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
import {
  COMMISSION_TYPES,
  COMMISSION_CALC_BASES,
  COMMISSION_FREQUENCIES,
} from '../schemas/commission-schedule.schema';

/** One entry in a bulk commission record call. */
export class CommissionEntryItemDto {
  @IsMongoId()
  @IsNotEmpty()
  teamMemberId: string;

  /**
   * 'commission' or 'incentive'. Both are treated identically in the ledger.
   * Use 'incentive' for performance-linked top-ups that are not sales-linked.
   * Legacy records may use 'incentive'; new entries default to 'commission'.
   */
  @IsEnum(['commission', 'incentive'])
  category: 'commission' | 'incentive';

  @IsEnum(COMMISSION_TYPES)
  commissionType: (typeof COMMISSION_TYPES)[number];

  @IsNumber()
  @Min(0.01)
  amount: number;

  /**
   * Short label shown in payslip and adjustment history, e.g.
   * "Sales Commission - May 2026" or "Referral Incentive".
   */
  @IsString()
  @IsNotEmpty()
  reasonTitle: string;

  @IsString()
  @IsOptional()
  note?: string;

  /** Reference number (invoice, order ID, etc.) for traceability. Optional. */
  @IsString()
  @IsOptional()
  reference?: string;
}

/** Bulk-capable commission create: posts entries for one or many members in one period. */
export class RecordCommissionEntriesDto {
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @IsInt()
  @Min(2000)
  year: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CommissionEntryItemDto)
  entries: CommissionEntryItemDto[];
}

/** Query for the YTD commission/incentive report. */
export class CommissionYtdQueryDto {
  @IsMongoId()
  @IsOptional()
  teamMemberId?: string;

  /**
   * The start year of the Indian financial year (Apr-Mar).
   * fyStartYear=2025 means FY 2025-26 (April 2025 - March 2026).
   * Defaults to current financial year when omitted.
   *
   * NOTE: query params arrive as strings; @Type(() => Number) coerces so the
   * @IsInt() check passes. Without it the global ValidationPipe (transform:true
   * but no enableImplicitConversion) rejects "2026" with a 400.
   */
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @IsOptional()
  fyStartYear?: number;
}

/** Query for listing commission/incentive entries. */
export class ListCommissionEntriesQueryDto {
  @IsMongoId()
  @IsOptional()
  teamMemberId?: string;

  // @Type(() => Number): query params arrive as strings; coerce so @IsInt passes.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  @IsOptional()
  month?: number;

  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @IsOptional()
  year?: number;

  /**
   * Filter by category. Omit to return both 'commission' and 'incentive'.
   */
  @IsEnum(['commission', 'incentive'])
  @IsOptional()
  category?: 'commission' | 'incentive';
}

/** Create a recurring commission schedule rule. */
export class CreateCommissionScheduleDto {
  @IsMongoId()
  @IsNotEmpty()
  teamMemberId: string;

  @IsEnum(COMMISSION_TYPES)
  commissionType: (typeof COMMISSION_TYPES)[number];

  @IsEnum(COMMISSION_CALC_BASES)
  calcBasis: (typeof COMMISSION_CALC_BASES)[number];

  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsEnum(COMMISSION_FREQUENCIES)
  frequency: (typeof COMMISSION_FREQUENCIES)[number];

  @IsInt()
  @Min(1)
  @Max(12)
  startMonth: number;

  @IsInt()
  @Min(2000)
  startYear: number;

  @IsInt()
  @Min(1)
  @Max(12)
  @IsOptional()
  endMonth?: number;

  @IsInt()
  @Min(2000)
  @IsOptional()
  endYear?: number;

  @IsString()
  @IsOptional()
  note?: string;
}

/** Patch a schedule: update amount, dates, note, or status. */
export class UpdateCommissionScheduleDto {
  @IsNumber()
  @Min(0.01)
  @IsOptional()
  amount?: number;

  @IsEnum(COMMISSION_TYPES)
  @IsOptional()
  commissionType?: (typeof COMMISSION_TYPES)[number];

  @IsInt()
  @Min(1)
  @Max(12)
  @IsOptional()
  endMonth?: number;

  @IsInt()
  @Min(2000)
  @IsOptional()
  endYear?: number;

  @IsString()
  @IsOptional()
  note?: string;

  @IsEnum(['active', 'paused'])
  @IsOptional()
  status?: 'active' | 'paused';
}

/** Manually trigger disbursement for a specific due period. */
export class DisburseScheduleDto {
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @IsInt()
  @Min(2000)
  year: number;
}

/** Query for listing schedules. */
export class ListSchedulesQueryDto {
  @IsMongoId()
  @IsOptional()
  teamMemberId?: string;

  @IsEnum(['active', 'paused', 'completed'])
  @IsOptional()
  status?: 'active' | 'paused' | 'completed';

  @IsEnum(COMMISSION_TYPES)
  @IsOptional()
  commissionType?: (typeof COMMISSION_TYPES)[number];
}
