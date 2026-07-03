import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
// Inbox media may be a public https URL OR a private `r2-private://` ref (chat
// attachments are private). The custom guard accepts both; ownership is still
// enforced in inbox.service via MediaOwnershipService.
import { IsMediaRef } from '../../../uploads/validators/is-media-ref.validator';
import {
  INBOX_BODY_MAX,
  INBOX_CONTEXT_ENTITY_TYPES,
  INBOX_MEDIA_MAX,
  INBOX_REPORT_REASONS,
  type InboxContextEntityType,
  type InboxReportReason,
} from '../inbox.constants';

/** One photo attachment (the upload service already returned the URL). */
export class MessageMediaDto {
  @IsString()
  @IsMediaRef()
  url: string;

  @IsString()
  mime: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  height?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  sizeBytes?: number;
}

/**
 * Send a message into an existing thread. `clientMsgId` is the client-generated
 * idempotency key. `kind` is derived server-side from the payload (voice if
 * `audioUrl`, else photo if `media`, else text), so it is not accepted here.
 */
export class SendMessageDto {
  @IsString()
  @MaxLength(80)
  clientMsgId: string;

  @IsOptional()
  @IsString()
  @MaxLength(INBOX_BODY_MAX)
  body?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(INBOX_MEDIA_MAX)
  @ValidateNested({ each: true })
  @Type(() => MessageMediaDto)
  media?: MessageMediaDto[];

  @IsOptional()
  @IsString()
  @IsMediaRef()
  audioUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  audioDurationSec?: number;
}

/** Start (or resume) a free DM with another member. */
export class StartDmDto {
  @IsMongoId()
  recipientUserId: string;
}

/**
 * Start (or resume) a context thread bound to a marketplace inquiry / job
 * application / rfq quote. Used by the source-feature handoffs (wave I4).
 */
export class StartContextThreadDto {
  @IsMongoId()
  recipientUserId: string;

  @IsIn(INBOX_CONTEXT_ENTITY_TYPES)
  contextEntityType: InboxContextEntityType;

  @IsMongoId()
  contextEntityId: string;
}

/** Mark a thread read up to (and including) `upToSeq`. */
export class MarkReadDto {
  @IsInt()
  @Min(0)
  upToSeq: number;
}

/** Report a thread / message for moderation. */
export class ReportThreadDto {
  @IsIn(INBOX_REPORT_REASONS)
  reason: InboxReportReason;

  @IsOptional()
  @IsMongoId()
  messageId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  detail?: string;
}
