/**
 * Query DTO for GET .../smart-defaults.
 *
 * `partyId` is optional + validated as a Mongo ObjectId. When omitted the
 * controller returns an empty defaults shape (no party context = nothing to
 * pre-fill). Validation runs via Nest's global ValidationPipe (whitelist).
 *
 * Links to: smart-defaults.controller (consumer), SmartDefaultsService.getForParty.
 */
import { IsMongoId, IsOptional } from 'class-validator';

export class GetSmartDefaultsDto {
  @IsOptional()
  @IsMongoId()
  partyId?: string;
}
