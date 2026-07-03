import { IsString } from 'class-validator';

/**
 * Query for `GET /connect/people` — a comma-separated list of `User` ids to
 * resolve to viewer-facing people-card identity. The controller splits,
 * trims, and caps the list.
 */
export class PeopleLookupQueryDto {
  @IsString()
  ids: string;
}
