/**
 * ManekHR Connect -- content-report vocabulary (public UGC abuse reports).
 *
 * Shared by the schema, DTOs, and service so the report reasons/types/statuses
 * never drift. Distinct from the inbox message-report vocabulary
 * (inbox.constants) -- that path covers private DMs; this covers PUBLIC,
 * ad-bearing UGC (posts, comments, profiles, listings) and feeds the admin
 * moderation queue required for Google AdSense approval.
 *
 * Cross-module links: schemas/content-report.schema.ts, dto/content-report.dto.ts,
 * content-reports.service.ts. The takedown event below is consumed by
 * feed.service (post/comment) + listing-moderation.service (listing).
 */

/** What kind of public content a report targets. */
export const CONTENT_REPORT_TARGET_TYPES = ['post', 'comment', 'profile', 'listing'] as const;
export type ContentReportTargetType = (typeof CONTENT_REPORT_TARGET_TYPES)[number];

/** Why the reporter flagged it (maps to the Google UGC policy categories). */
export const CONTENT_REPORT_REASONS = [
  'spam',
  'harassment',
  'hate',
  'adult',
  'scam',
  'misinformation',
  'other',
] as const;
export type ContentReportReason = (typeof CONTENT_REPORT_REASONS)[number];

/** Moderation lifecycle. `actioned` = content removed / handled; `dismissed` = no action. */
export const CONTENT_REPORT_STATUSES = ['open', 'actioned', 'dismissed'] as const;
export type ContentReportStatus = (typeof CONTENT_REPORT_STATUSES)[number];

/**
 * Domain event the moderation "Remove" action emits. feed.service and
 * listing-moderation.service listen and perform the real cascade delete/takedown,
 * so content-reports stays a leaf module (no service-level circular deps).
 */
export const CONTENT_TAKEDOWN_EVENT = 'connect.content.takedown';

/** Payload for CONTENT_TAKEDOWN_EVENT. */
export interface ContentTakedownEvent {
  targetType: ContentReportTargetType;
  targetId: string;
  /** Admin who actioned the report (for downstream audit on the cascade). */
  actorId: string;
}
