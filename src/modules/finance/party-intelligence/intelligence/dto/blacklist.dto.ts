/**
 * Phase 17 / FIN-16-01 D-04 — Blacklist DTO.
 *
 * Body for POST /workspaces/:wsId/parties/:partyId/intelligence/blacklist.
 * Reason is required (free text up to 500 chars).
 */
import { IsString, MaxLength, MinLength } from 'class-validator';

export class BlacklistDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
