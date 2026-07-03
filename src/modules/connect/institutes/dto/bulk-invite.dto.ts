import { ArrayMaxSize, ArrayMinSize, IsArray, IsNotEmpty, IsString } from 'class-validator';
import { BULK_INVITE_MAX } from '../connect-page-invite.service';

/**
 * Body DTO for `POST connect/company-pages/:pageId/student-invites` (Institutes
 * Phase 2, Feature 5: an institute bulk-invites a list of student phone numbers).
 *
 * What this does: validates the inbound phone list: a non-empty array of
 * non-empty strings, capped at `BULK_INVITE_MAX` (200). The numbers are
 * normalised + de-duped server-side in `ConnectPageInviteService.bulkInvite`
 * (each is coerced to the canonical `91XXXXXXXXXX` form; unparseable numbers are
 * reported as `invalid`, never errored), so this DTO only guards shape + size +
 * non-emptiness, NOT the phone format (a partial-success batch must tolerate a
 * stray bad number without a 400 for the whole request).
 *
 * Cross-module links: `BULK_INVITE_MAX` is the single source of truth shared with
 * the service's defensive cap. The `pageId` (the institute CompanyPage) is a PATH
 * param validated by the controller (`@IsMongoId`); the actor is ALWAYS
 * `req.user.sub`. Keep in sync with the web bulk-invite composer.
 */
export class BulkInviteDto {
  /** Student phone numbers to invite. Non-empty array of non-empty strings,
   *  capped at 200. Format / normalisation handled server-side. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_INVITE_MAX)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  phones: string[];
}
