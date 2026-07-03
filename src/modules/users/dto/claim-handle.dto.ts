import { IsString, Length } from 'class-validator';
import { HANDLE_MAX_LEN, HANDLE_MIN_LEN } from '../utils/handle.util';

/**
 * Body for `PATCH /me/profile/handle` — the user-initiated handle change. The
 * full format/reserved/uniqueness/cooldown checks run inside
 * `UsersService.claimHandle`; the DTO enforces the shape + length envelope so
 * obviously-malformed payloads short-circuit before hitting the database.
 *
 * Length here matches the regex in `handle.util.ts` so the two sources of
 * truth cannot drift. The deeper format validation happens server-side via
 * `validateHandleFormat` (regex + reserved-list).
 */
export class ClaimHandleDto {
  @IsString()
  @Length(HANDLE_MIN_LEN, HANDLE_MAX_LEN)
  handle!: string;
}
