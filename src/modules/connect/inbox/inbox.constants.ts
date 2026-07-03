/**
 * ManekHR Connect -- Inbox (Phase 7) shared constants.
 *
 * One place for the enums + tunables shared by the schemas, service, DTOs, and
 * (later) the gateway, so the message store, the realtime layer, and the web
 * client agree on the contract. Person-centric throughout (User ids only).
 */

/**
 * The unified-inbox channels. They are FILTER VIEWS over one thread store, not
 * separate engines: `dm` is a free person-to-person chat; `inquiry` /
 * `application` / `quote` / `candidate_request` are conversations bound to a live
 * marketplace / jobs / rfq / institutes entity (the thread carries a context ref,
 * never a copy); `system` is a platform-authored, read-only channel.
 *
 * `candidate_request` (Institutes Phase 2, Feature 4) wraps a `CandidateRequest`
 * (a business's "hire our trained candidates" lead to an institute). Keep this
 * list in sync with INBOX_CONTEXT_ENTITY_TYPES below + the channel-mapping
 * ternary + the ThreadContext union + hydrateCandidateRequestContexts in
 * inbox.service.ts. The thread schema reads this array for its `channelType`
 * enum, so a new value is picked up there automatically.
 */
export const INBOX_CHANNEL_TYPES = [
  'dm',
  'inquiry',
  'application',
  'quote',
  'candidate_request',
  'system',
] as const;
export type InboxChannelType = (typeof INBOX_CHANNEL_TYPES)[number];

/**
 * The entity a context thread wraps. `null` for `dm` / `system`. `CandidateRequest`
 * (Institutes Phase 2, Feature 4) is the institutes hire-lead entity, owned by the
 * institutes module; the inbox reads it schema-only for the subject card. The thread
 * schema reads this array for its `contextEntityType` enum + StartContextThreadDto
 * `@IsIn(INBOX_CONTEXT_ENTITY_TYPES)` accepts the new value automatically.
 */
export const INBOX_CONTEXT_ENTITY_TYPES = [
  'Inquiry',
  'JobApplication',
  'Quote',
  'CandidateRequest',
] as const;
export type InboxContextEntityType = (typeof INBOX_CONTEXT_ENTITY_TYPES)[number];

/** Message payload kinds. `system` carries platform copy with no sender. */
export const INBOX_MESSAGE_KINDS = ['text', 'photo', 'voice', 'system'] as const;
export type InboxMessageKind = (typeof INBOX_MESSAGE_KINDS)[number];

/** Reasons a member can report a thread / message. */
export const INBOX_REPORT_REASONS = ['spam', 'scam', 'abusive', 'off_topic', 'other'] as const;
export type InboxReportReason = (typeof INBOX_REPORT_REASONS)[number];

/** Lifecycle of a report row in the admin moderation queue (wave I5). */
export const INBOX_REPORT_STATUSES = ['open', 'dismissed', 'actioned'] as const;
export type InboxReportStatus = (typeof INBOX_REPORT_STATUSES)[number];

/** Media-scan lifecycle on an attachment (AV / content-scan seam, wave I5). */
export const INBOX_SCAN_STATUSES = ['pending', 'clean', 'flagged'] as const;
export type InboxScanStatus = (typeof INBOX_SCAN_STATUSES)[number];

/** Tunables. */
export const INBOX_BODY_MAX = 4000;
/** Cap on the denormalized last-message preview shown in the thread list. */
export const INBOX_PREVIEW_MAX = 140;
/** Max photos per message (v1). */
export const INBOX_MEDIA_MAX = 4;
/** Thread-list + message-page sizes (keyset paged, never `skip`). */
export const INBOX_THREAD_PAGE_SIZE = 25;
export const INBOX_MESSAGE_PAGE_SIZE = 30;
/** Hard cap on the since-cursor catch-up replay window (wave I2). */
export const INBOX_RESUME_MAX = 200;
