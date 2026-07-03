/**
 * Phase 17 / FIN-16-03 — DTO for manual timeline entries.
 *
 * Whitelisted to the three D-20 manual types (call.logged | email.logged |
 * note.added). System-emitted types are NOT acceptable here — those flow
 * through EventEmitter2 from the producer services.
 */
import {
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export const MANUAL_TIMELINE_EVENT_TYPES = [
  'call.logged',
  'email.logged',
  'note.added',
] as const;

export type ManualTimelineEventType = (typeof MANUAL_TIMELINE_EVENT_TYPES)[number];

export class CreateTimelineEventDto {
  @IsString()
  @IsIn(MANUAL_TIMELINE_EVENT_TYPES as unknown as string[])
  type: ManualTimelineEventType;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  summary: string;

  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>;

  /** Defaults to now() when absent. */
  @IsOptional()
  @IsISO8601()
  occurredAt?: string;
}
