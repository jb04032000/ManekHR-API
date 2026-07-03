import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsMongoId, IsOptional, Matches } from 'class-validator';
import { FULL_INDIAN_RE, transformMobile } from '../../auth/utils/mobile-normalizer';

export class CheckIdentifierQueryDto {
  @Transform(transformMobile)
  @Matches(FULL_INDIAN_RE, {
    message: 'Enter a valid Indian mobile number (10 digits, +91 prefix optional)',
  })
  @IsOptional()
  mobile?: string;

  @IsEmail() @IsOptional() email?: string;

  @IsMongoId() @IsOptional() excludeId?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  classify?: boolean;
}

export interface IdentifierAvailability {
  available: boolean;
  conflictMemberName?: string;
}

export interface CheckIdentifierResult {
  mobile?: IdentifierAvailability;
  email?: IdentifierAvailability;
}

/**
 * Discriminated union describing the full identity-collision picture for a
 * typed mobile number. Returned when `?classify=true` is appended to
 * `GET /workspaces/:wsId/team/check-identifier`.
 *
 * Privacy contract (binding):
 *  - `registered`: cross-tenant signal detected but ZERO fields beyond `kind`.
 *    No workspace counts, no names, no ids. Object.keys MUST equal ['kind'].
 *  - Same-workspace cases reveal member names because the caller already owns
 *    that workspace's data.
 */
export type MobileClassification =
  /** Case 1 - mobile is unknown to the platform. */
  | { kind: 'unregistered' }
  /** Case 8 - mobile failed normalisation (not a valid Indian mobile). */
  | { kind: 'invalid_format' }
  /** Case 2 - mobile belongs to THIS workspace's owner. */
  | { kind: 'workspace_owner_self'; ownerName: string }
  /** Case 5 - mobile is already assigned to an active member in THIS workspace. */
  | { kind: 'active_member_this_ws'; memberId: string; memberName: string }
  /** Case 6 - mobile is assigned to an archived member in THIS workspace. */
  | { kind: 'archived_member_this_ws'; memberId: string; memberName: string }
  /** Case 10a - mobile has a pending (unexpired) invite in THIS workspace. */
  | {
      kind: 'pending_invite_this_ws';
      memberId: string;
      memberName: string;
      inviteExpiresAt: string;
    }
  /**
   * Cross-tenant signal - mobile is registered on the platform but belongs to
   * another workspace (as a platform User, TeamMember, or pending invite).
   * ZERO fields beyond `kind` - no workspace counts, no names, no ids.
   */
  | { kind: 'registered' };
