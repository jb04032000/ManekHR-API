/**
 * Phase 17 / FIN-16-05 D-32 — DTO for PATCH per-contact suppressGreetings.
 *
 * Consumed by Plan 17-08 web Suppress button on the Upcoming Greetings table.
 */

import { IsBoolean } from 'class-validator';

export class UpdateContactSuppressGreetingsDto {
  @IsBoolean()
  suppressGreetings: boolean;
}
