/**
 * Phase 17 / FIN-16-03 — DTO for the cursor-paginated timeline list endpoint.
 */
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

import { PARTY_TIMELINE_EVENT_TYPES } from '../party-timeline-event.schema';

export class ListTimelineDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;

  /** Cursor: returns events with occurredAt < before. */
  @IsOptional()
  @IsISO8601()
  before?: string;

  @IsOptional()
  @IsArray()
  @IsIn(PARTY_TIMELINE_EVENT_TYPES as unknown as string[], { each: true })
  types?: string[];
}
