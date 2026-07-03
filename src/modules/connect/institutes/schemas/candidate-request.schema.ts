import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * ManekHR Connect -- `CandidateRequest` (Institutes Phase 2, Feature 4:
 * hiring-leads-to-inbox).
 *
 * What this does: persists a business's "hire our trained candidates" request to
 * a training institute. A business owner opens an institute's public page and
 * asks the institute to refer / connect them with the institute's trained
 * students; that request is recorded here AND seeded into the institute owner's
 * unified inbox as a new `candidate_request` context thread (the inbox renders a
 * rich subject card from this row, hydrated at read time, never copied).
 *
 * Cross-module links:
 *  - `companyPageId` -> Connect entities `CompanyPage` (the institute page the
 *    lead targets; must be `kind: 'institute'` + `visibility: 'public'`, enforced
 *    in CandidateRequestService.create).
 *  - `instituteOwnerUserId` -> `User` (the page owner = the inbox recipient,
 *    copied from `CompanyPage.ownerUserId` at create time).
 *  - `fromUserId` -> `User` (the business sending the lead = the inbox sender).
 *  - The inbox seeds a thread via `InboxService.findOrCreateContextThread(
 *    fromUserId, instituteOwnerUserId, 'CandidateRequest', <this _id>)` and the
 *    status is advanced from the inbox activity event (`onInboxThreadActivity`):
 *    the institute owner opening the thread -> `viewed`; replying -> `replied`.
 *
 * Keep in sync with:
 *  - the inbox `CandidateRequest` context-entity type + `candidate_request`
 *    channel (inbox.constants.ts) + the `hydrateCandidateRequestContexts` reader
 *    (inbox.service.ts), which reads `status` + `message` off this row + the page
 *    name/slug/logo + the sender name.
 *  - the `CandidateRequestStatus` enum mirrors the inquiry status lifecycle
 *    (`sent` -> `viewed` -> `replied`, plus an institute-side `archived`).
 *
 * Additive only: this is a brand-new collection, so there is no legacy document
 * to migrate; every @Prop carries an explicit `{ type }` (required by the repo's
 * Vitest SWC transform so `SchemaFactory.createForClass` resolves).
 */

/** Lifecycle of a hire lead. Mirrors the inquiry status flow:
 *  - `sent`     -- created, not yet opened by the institute owner.
 *  - `viewed`   -- the institute owner opened the inbox thread.
 *  - `replied`  -- the institute owner replied in the inbox thread.
 *  - `archived` -- the institute owner archived the lead (manual close). */
export const CANDIDATE_REQUEST_STATUSES = ['sent', 'viewed', 'replied', 'archived'] as const;
export type CandidateRequestStatus = (typeof CANDIDATE_REQUEST_STATUSES)[number];

/** Max length of the optional message a business attaches to the lead. */
export const CANDIDATE_REQUEST_MESSAGE_MAX = 1000;

@Schema({ timestamps: true, collection: 'connect_candidate_requests' })
export class CandidateRequest extends Document {
  /** The institute `CompanyPage` this lead targets. */
  @Prop({ type: Types.ObjectId, ref: 'CompanyPage', required: true })
  companyPageId: Types.ObjectId;

  /** The business `User` sending the lead (the inbox thread sender). */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  fromUserId: Types.ObjectId;

  /** The institute page owner `User` (the inbox thread recipient). Copied from
   *  `CompanyPage.ownerUserId` at create time so a later page-owner change does
   *  not silently reroute an in-flight lead. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  instituteOwnerUserId: Types.ObjectId;

  /** Optional pitch from the business (what roles, how many, where). Capped. */
  @Prop({ type: String, trim: true, maxlength: CANDIDATE_REQUEST_MESSAGE_MAX, default: '' })
  message: string;

  /** Lead lifecycle. Advanced from inbox activity (see onInboxThreadActivity). */
  @Prop({ type: String, enum: CANDIDATE_REQUEST_STATUSES, default: 'sent' })
  status: CandidateRequestStatus;

  // `createdAt` / `updatedAt` from `{ timestamps: true }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type CandidateRequestDocument = CandidateRequest & Document;

export const CandidateRequestSchema = SchemaFactory.createForClass(CandidateRequest);

// The institute owner's hire-lead queue, newest first (the owner's review list +
// the per-owner lead count). Mirrors the inquiry inbox index shape.
CandidateRequestSchema.index({ instituteOwnerUserId: 1, createdAt: -1 });
