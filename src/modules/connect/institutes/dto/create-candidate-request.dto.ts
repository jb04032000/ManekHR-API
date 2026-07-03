import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CANDIDATE_REQUEST_MESSAGE_MAX } from '../schemas/candidate-request.schema';

/**
 * Body DTO for `POST connect/company-pages/:pageId/hire-leads` (Institutes
 * Phase 2, Feature 4: a business sends a "hire our trained candidates" request
 * to an institute).
 *
 * What this does: validates the optional free-text pitch the business attaches.
 * The `pageId` (the institute CompanyPage) is a PATH param validated by the
 * controller; the sender is ALWAYS `req.user.sub` (never the body), so this DTO
 * carries only the message.
 *
 * Cross-module links: `message` is capped at the same `CANDIDATE_REQUEST_MESSAGE_MAX`
 * the `CandidateRequest` schema enforces (single source of truth), and it becomes
 * the FIRST inbox message body when the lead seeds its context thread
 * (CandidateRequestService.create -> InboxService.sendMessage). Keep in sync with
 * the web hire-lead composer.
 */
export class CreateCandidateRequestDto {
  /** Optional pitch (what roles, how many, where). Trimmed + capped server-side. */
  @IsOptional()
  @IsString()
  @MaxLength(CANDIDATE_REQUEST_MESSAGE_MAX)
  message?: string;
}
