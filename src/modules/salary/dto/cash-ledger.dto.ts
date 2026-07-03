/**
 * DTOs for the Cash Ledger module (Phase 3C - Daily-Wage Running Ledger).
 *
 * RecordLedgerEntriesDto: bulk-capable create for earning/draw/adjustment entries.
 * LedgerQueryDto: date-range filter for per-member ledger view.
 * WorkspaceBalanceQueryDto: workspace-level balance board filter.
 * SettleDto: settle a worker (or many) up to a cutoff date.
 */

import {
  IsArray,
  IsDateString,
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
import { CASH_LEDGER_ENTRY_TYPES } from '../schemas/cash-ledger-entry.schema';

// Earning/draw/adjustment are the create-able types; settlement is created
// internally by the settle method. Callers cannot POST a settlement directly
// via recordEntries - they must use the settle endpoint.
const RECORD_ENTRY_TYPES = ['earning', 'draw', 'adjustment'] as const;
type RecordEntryType = (typeof RECORD_ENTRY_TYPES)[number];

/** One entry in a bulk record call. */
export class LedgerEntryItemDto {
  @IsMongoId()
  @IsNotEmpty()
  teamMemberId: string;

  /**
   * 'earning' - wages earned by the worker for a piece/day.
   * 'draw' - cash taken by the worker in advance.
   * 'adjustment' - correction; amount can be negative (subtract) or positive (add).
   */
  @IsEnum(RECORD_ENTRY_TYPES)
  type: RecordEntryType;

  /**
   * Amount in rupees.
   * For 'draw' and 'earning': must be > 0.
   * For 'adjustment': can be any non-zero number (negative = subtraction).
   */
  @IsNumber()
  amount: number;

  /**
   * The date this event occurred (ISO 8601 date string, e.g. "2026-05-31").
   * Defaults to today when omitted (see service layer).
   */
  @IsDateString()
  @IsOptional()
  date?: string;

  @IsString()
  @IsOptional()
  note?: string;
}

/**
 * Bulk-capable create for earning/draw/adjustment entries.
 * Up to 50 rows per call (matches the UI bulk-entry form limit).
 */
export class RecordLedgerEntriesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LedgerEntryItemDto)
  entries: LedgerEntryItemDto[];
}

/** Query for the per-member ledger: date range + optional type filter. */
export class LedgerQueryDto {
  /**
   * Filter entries on or after this date (ISO 8601).
   */
  @IsDateString()
  @IsOptional()
  fromDate?: string;

  /**
   * Filter entries on or before this date (ISO 8601).
   */
  @IsDateString()
  @IsOptional()
  toDate?: string;

  /**
   * Filter by entry type. Omit for all types.
   */
  @IsEnum(CASH_LEDGER_ENTRY_TYPES)
  @IsOptional()
  type?: (typeof CASH_LEDGER_ENTRY_TYPES)[number];

  /**
   * Page number (1-based). Defaults to 1.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  /**
   * Entries per page. Defaults to 50, max 200.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  limit?: number;
}

/** Query for the workspace-level balance board. */
export class WorkspaceBalanceQueryDto {
  /**
   * 'nonzero' returns only members with a non-zero current balance.
   * 'all' returns all members who have at least one entry.
   * Defaults to 'nonzero'.
   */
  @IsEnum(['nonzero', 'all'])
  @IsOptional()
  filter?: 'nonzero' | 'all';

  /**
   * Limit results (default 100, max 500).
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  @IsOptional()
  limit?: number;
}

/** Settle one or many workers up to a cutoff date. */
export class SettleDto {
  /**
   * Workers to settle. Must have at least one.
   * Settling multiple workers in one call is useful for Friday end-of-week
   * batch payouts.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  teamMemberIds: string[];

  /**
   * Settle all open entries up to and including this date (ISO 8601).
   * Defaults to today when omitted.
   */
  @IsDateString()
  @IsOptional()
  upToDate?: string;

  @IsString()
  @IsOptional()
  note?: string;
}
