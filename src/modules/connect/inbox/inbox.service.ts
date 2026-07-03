import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import * as Sentry from '@sentry/nestjs';
import { Thread, type ThreadDocument } from './schemas/thread.schema';
import { Message, type MessageDocument } from './schemas/message.schema';
import { UserBlock, type UserBlockDocument } from './schemas/user-block.schema';
import { InboxReport, type InboxReportDocument } from './schemas/inbox-report.schema';
import {
  INBOX_MESSAGE_PAGE_SIZE,
  INBOX_PREVIEW_MAX,
  INBOX_RESUME_MAX,
  INBOX_THREAD_PAGE_SIZE,
  type InboxChannelType,
  type InboxContextEntityType,
  type InboxMessageKind,
} from './inbox.constants';
import { InboxGateway } from './inbox.gateway';
// Schema-only imports (NOT the owning modules) so the inbox can hydrate a
// thread's context (product / job / RFQ) by reading the source collections at
// read time - no module cycle. application->job and quote->rfq mirror the
// original inquiry->listing pattern (see hydrateContexts).
import {
  Inquiry,
  type InquiryDocument,
  type InquiryStatus,
} from '../marketplace/schemas/inquiry.schema';
import {
  Listing,
  type ListingDocument,
  type ListingPriceType,
} from '../marketplace/schemas/listing.schema';
import {
  JobApplication,
  type JobApplicationDocument,
  type ApplicationStatus,
} from '../jobs/schemas/job-application.schema';
import {
  Job,
  type JobDocument,
  type JobWageType,
  type JobStatus,
} from '../jobs/schemas/job.schema';
import { CompanyPage, type CompanyPageDocument } from '../entities/schemas/company-page.schema';
import { Quote, type QuoteDocument, type QuoteStatus } from '../rfq/schemas/quote.schema';
import { Rfq, type RfqDocument, type RfqStatus } from '../rfq/schemas/rfq.schema';
// Schema-only import of the institutes hire-lead entity (Institutes Phase 2,
// Feature 4) so the inbox can hydrate a candidate_request thread's subject card
// without importing the owning institutes module (mirrors inquiry/quote: read-only,
// no cycle). The page name/logo come from the CompanyPage model already imported.
import {
  CandidateRequest,
  type CandidateRequestDocument,
  type CandidateRequestStatus,
} from '../institutes/schemas/candidate-request.schema';
// The applicant's public Connect profile facts (headline / skills / district) for
// the EMPLOYER-ONLY applicant snapshot on a job-application card. Never the
// applicant's own view (leak guard); never private fields.
import { ConnectProfile } from '../profile/schemas/connect-profile.schema';
// Schema-only token (no module cycle) so the cold-DM gate can read the recipient's
// canonical-ordered `Connection` edge. Owns the "only a first-degree connection may
// cold-message a non-public profile" rule -> keep in sync with NetworkService's
// sortedPair convention (userA = lexicographically-smaller id).
import { Connection } from '../network/schemas/connection.schema';
import { User } from '../../users/schemas/user.schema';
import { AuditService } from '../../audit/audit.service';
import { AppModule } from '../../../common/enums/modules.enum';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { MessagingRateLimiter } from './messaging-rate-limiter';
import { resolveMessagingTier, type MessagingTier } from './messaging-limits';
import { MessagingSpamGuard } from './messaging-spam-guard';
import { CONNECT_INBOX_THREAD_ACTIVITY } from './inbox.events';
import { scoreColdContact, decideSpamAction } from './spam-scoring';
import { ConnectAllowanceService } from '../monetization/connect-allowance.service';
import { MediaOwnershipService } from '../../uploads/services/media-ownership.service';
import { PrivateMediaService } from '../../uploads/services/private-media.service';
import type { SendMessageDto, ReportThreadDto } from './dto/inbox.dto';

const DUPLICATE_KEY_ERROR = 11000;

/** The other party on a thread, hydrated for the list / header. */
export interface InboxParty {
  userId: string;
  name: string;
  avatar: string | null;
  handle: string | null;
  /**
   * True for a seeded demo / sample account (User.isDemo). Lets the thread row +
   * conversation header show a "Sample" tag so a real user knows the other party
   * is example content. See DEMO-CONTENT-TRUST-UX-PLAN.md (Phase 1).
   */
  isDemo: boolean;
}

/**
 * What a context thread is ABOUT, hydrated at read time from the live source row
 * (never copied/persisted). A discriminated union, one member per context kind:
 *  - inquiry     -> the marketplace Listing (buyer<->seller product chat).
 *  - application -> the Job a JobApplication is for (employer<->applicant chat).
 *  - quote       -> the Rfq a Quote answers (buyer<->supplier chat).
 * Drives the pinned subject card in the web conversation (ContextCard.tsx) + the
 * thread-list preview. `null` for a dm / system thread or when the source entity
 * (or its parent) was deleted -> the card renders its lean fallback. Keep in sync
 * with the web mirror `InboxThreadContext` (inbox.types.ts).
 * Leak guard: only SHARED entity facts both participants already see in the
 * jobs/RFQ UI are surfaced here - never private media (resume/voice note) or any
 * counterpart PII beyond the `party`.
 */
/**
 * EMPLOYER-ONLY snapshot of the applicant, attached to an `application` context
 * when the VIEWER is the job's employer. Public Connect-profile facts only (the
 * same facts visible on the applicant's public `/u/[id]` profile) + a derived
 * skill match + a past-applicant flag. NEVER sent to the applicant's own view,
 * and NEVER carries private fields (resume / voice note / contact). `null` when
 * the applicant has no Connect profile yet.
 */
export interface ApplicantSnapshot {
  /** The applicant's own professional one-liner (carries their stated experience). */
  headline: string | null;
  /** Job skills the applicant also lists (original job-skill casing), best-first. */
  matchedSkills: string[];
  /** Total skills the job asks for, so the FE can render "N of M". */
  jobSkillCount: number;
  district: string | null;
  /** Applied to more than one of THIS employer's jobs (a repeat applicant). */
  pastApplicant: boolean;
}

export type ThreadContext =
  | {
      kind: 'inquiry';
      listingId: string;
      title: string;
      coverImage: string | null;
      priceType: ListingPriceType;
      priceMin: number | null;
      priceMax: number | null;
      unit: string | null;
      moq: number | null;
      status: InquiryStatus | null;
    }
  | {
      kind: 'application';
      jobId: string;
      title: string;
      companyName: string | null;
      companyLogo: string | null;
      wageType: JobWageType | null;
      wageMin: number | null;
      wageMax: number | null;
      district: string | null;
      status: ApplicationStatus;
      viewed: boolean;
      jobStatus: JobStatus;
      /** Drives which inline actions the card offers (gates the snapshot too). */
      viewerRole: 'employer' | 'applicant';
      /** Employer-only applicant snapshot; `null` for the applicant's own view. */
      applicant: ApplicantSnapshot | null;
    }
  | {
      kind: 'quote';
      rfqId: string;
      title: string;
      sampleImage: string | null;
      price: number | null;
      quantity: number | null;
      unit: string | null;
      budgetMin: number | null;
      budgetMax: number | null;
      district: string | null;
      status: QuoteStatus;
      rfqStatus: RfqStatus;
      /** Drives which inline actions the card offers (buyer accept/decline vs supplier update). */
      viewerRole: 'buyer' | 'supplier';
    }
  | {
      // candidate_request -> the institute CompanyPage a business pitched (Institutes
      // Phase 2, Feature 4). The card shows the institute identity (so the owner sees
      // which of their pages the lead is for) + the business sender's name + the lead
      // status + a short message snippet. Hydrated by hydrateCandidateRequestContexts.
      // Keep in sync with the institutes CandidateRequest schema + the web card.
      kind: 'candidate_request';
      candidateRequestId: string;
      /** The institute page the lead targets. */
      pageId: string;
      pageName: string;
      pageSlug: string | null;
      pageLogo: string | null;
      /** The business member who sent the lead (display name). */
      fromUserName: string | null;
      status: CandidateRequestStatus;
      /** Short preview of the business's pitch (capped); empty when none. */
      messageSnippet: string;
    };

/** A hydrated thread row for the inbox list. */
export interface ThreadListItem {
  _id: string;
  channelType: InboxChannelType;
  contextEntityType: InboxContextEntityType | null;
  contextEntityId: string | null;
  /** What the thread is about (product card source); null for dm / system. */
  context: ThreadContext | null;
  party: InboxParty | null;
  lastMessage: {
    preview: string;
    kind: InboxMessageKind;
    senderUserId: string | null;
    seq: number;
    createdAt: string;
  } | null;
  lastActivityAt: string;
  unreadCount: number;
  archived: boolean;
  muted: boolean;
  closed: boolean;
}

/**
 * One item in a per-person UNIFIED timeline (the "contexts as inline messages"
 * view): either a hydrated context card (the application/inquiry/quote summary,
 * placed at the context thread's creation time) or a chat message. Built by
 * buildPersonTimeline by merging all of a pair's threads, sorted by createdAt.
 * Cross-module: mirrored by the web `PersonTimelineItem` (inbox.types.ts) +
 * rendered by UnifiedConversationPane. Watch: `seq` is PER-THREAD here, never
 * global - order across subjects relies on createdAt only.
 */
export type PersonTimelineItem =
  | {
      type: 'context';
      threadId: string;
      channelType: InboxChannelType;
      /** The application / quote / inquiry id - lets the inline card drive its
       *  role-gated actions (Accept/Reject/...) the same way the pinned card does. */
      contextEntityId: string | null;
      context: ThreadContext;
      createdAt: string;
    }
  | {
      type: 'message';
      threadId: string;
      channelType: InboxChannelType;
      message: Record<string, unknown>;
      createdAt: string;
    };

/** A pair's merged timeline + the other party (for the header) + the per-thread
 *  newest-seq cursors (the web pages / marks-read each underlying thread
 *  independently; there is no global cursor). `otherLastReadSeq` is the OTHER
 *  participant's read watermark per thread -> the web turns my sent ticks blue
 *  (read) when my message `seq` <= it. Live-updated by the `inbox:read` socket
 *  event (markRead emits it); keep in sync with the web `PersonTimeline` mirror. */
export interface PersonTimeline {
  party: InboxParty | null;
  items: PersonTimelineItem[];
  threads: Array<{
    threadId: string;
    channelType: InboxChannelType;
    newestSeq: number;
    otherLastReadSeq: number;
  }>;
}

interface LeanUserSummary {
  _id: Types.ObjectId;
  name: string;
  profilePicture?: string;
  handle?: string | null;
  isDemo?: boolean;
}

/**
 * ManekHR Connect -- Inbox (Phase 7). The durable message store + the send /
 * read pipeline. Person-centric (User ids only; no workspace). The WebSocket
 * (wave I2) only accelerates delivery; this service + Mongo are the contract:
 *
 *  - `seq` is a server-assigned per-thread monotonic sequence (atomic `$inc`),
 *    the stable order + keyset cursor + since-cursor catch-up key.
 *  - `clientMsgId` is unique per thread, so a retried send is idempotent.
 *  - unread is a denormalized per-participant counter mutated atomically.
 *
 * Realtime emit + the open-DM spam/rate-limit scoring + the admin moderation
 * queue arrive in waves I2 / I5; block + report land here so the safety floor
 * exists from day one.
 */
@Injectable()
export class InboxService {
  private readonly logger = new Logger('InboxService');

  constructor(
    @InjectModel(Thread.name) private readonly threadModel: Model<ThreadDocument>,
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
    @InjectModel(UserBlock.name) private readonly blockModel: Model<UserBlockDocument>,
    @InjectModel(InboxReport.name) private readonly reportModel: Model<InboxReportDocument>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    // Read-only access for context hydration (inquiry -> listing product card).
    @InjectModel(Inquiry.name) private readonly inquiryModel: Model<InquiryDocument>,
    @InjectModel(Listing.name) private readonly listingModel: Model<ListingDocument>,
    private readonly audit: AuditService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
    @Optional() @Inject(NotificationsService) private readonly notifications?: NotificationsService,
    @Optional() @Inject(InboxGateway) private readonly gateway?: InboxGateway,
    @Optional() @Inject(MessagingRateLimiter) private readonly rateLimiter?: MessagingRateLimiter,
    @Optional()
    @Inject(ConnectAllowanceService)
    private readonly allowances?: ConnectAllowanceService,
    @Optional() @Inject(MessagingSpamGuard) private readonly spamGuard?: MessagingSpamGuard,
    // Decoupled status-sync signal for context threads (inquiry viewed / replied).
    @Optional() @Inject(EventEmitter2) private readonly eventEmitter?: EventEmitter2,
    // Shared media-ownership guard; @Optional() so positional unit-test
    // constructors keep working without supplying it.
    @Optional() private readonly media: MediaOwnershipService,
    // Read-path private-media decorator: turns stored `r2-private://` refs
    // (chat photos + voice notes) into fresh 1h signed URLs at serialize time.
    // @Optional() for the same positional-unit-test reason as `media`.
    @Optional() private readonly privateMedia?: PrivateMediaService,
    // Read-only models for the two ADDED context kinds (application -> Job,
    // quote -> Rfq), batched at read time in hydrateContexts. @Optional() so the
    // positional unit-test constructors (which stop at privateMedia) keep working;
    // in prod they are provided by inbox.module forFeature. Schema-only (no owning-
    // module import) -> no cycle, mirrors inquiryModel/listingModel above.
    @Optional()
    @InjectModel(JobApplication.name)
    private readonly jobApplicationModel?: Model<JobApplicationDocument>,
    @Optional() @InjectModel(Job.name) private readonly jobModel?: Model<JobDocument>,
    @Optional()
    @InjectModel(CompanyPage.name)
    private readonly companyPageModel?: Model<CompanyPageDocument>,
    @Optional() @InjectModel(Quote.name) private readonly quoteModel?: Model<QuoteDocument>,
    @Optional() @InjectModel(Rfq.name) private readonly rfqModel?: Model<RfqDocument>,
    // The applicant's public profile, read only for the employer-only snapshot.
    @Optional()
    @InjectModel(ConnectProfile.name)
    private readonly connectProfileModel?: Model<ConnectProfile>,
    // Read-only model for the candidate_request context kind (Institutes Phase 2,
    // Feature 4 -> CandidateRequest -> CompanyPage), batched at read time in
    // hydrateCandidateRequestContexts. APPENDED at the END so the positional
    // unit-test constructors (which stop earlier) keep working unchanged; in prod
    // it is provided by inbox.module forFeature. Schema-only -> no cycle, mirrors
    // the inquiry/quote read-only models above.
    @Optional()
    @InjectModel(CandidateRequest.name)
    private readonly candidateRequestModel?: Model<CandidateRequestDocument>,
    // Read-only `Connection` token for the cold-DM visibility gate (a non-public
    // recipient may only be cold-messaged by a first-degree connection). APPENDED at
    // the END so the positional unit-test constructors keep working unchanged; in
    // prod it is provided by inbox.module forFeature. Schema-only -> no cycle.
    @Optional()
    @InjectModel(Connection.name)
    private readonly connectionModel?: Model<Connection>,
  ) {}

  /**
   * Decorate outgoing messages: every private `r2-private://` ref on a photo
   * (`media[].url`) or voice note (`audioUrl`) is replaced with a fresh 1-hour
   * signed URL. Public URLs pass through untouched. Returns PLAIN objects with
   * the SAME shape the mongoose doc serialized to (mobile-app safe - only the
   * URL string values change, never field names). Batched: one signed URL per
   * distinct ref across the whole page, no per-message DB work.
   */
  private async decorateMessages(msgs: MessageDocument[]): Promise<Record<string, unknown>[]> {
    const plain = msgs.map((m) => (typeof m?.toObject === 'function' ? m.toObject() : m)) as Array<
      Record<string, unknown> & {
        audioUrl?: string | null;
        media?: Array<Record<string, unknown> & { url?: string | null }>;
      }
    >;
    if (!this.privateMedia) return plain;

    const refs: Array<string | null | undefined> = [];
    for (const m of plain) {
      refs.push(m.audioUrl);
      for (const med of m.media ?? []) refs.push(med.url);
    }
    const signed = await this.privateMedia.signMany(refs);
    if (signed.size === 0) return plain;

    for (const m of plain) {
      if (m.audioUrl) m.audioUrl = this.privateMedia.resolve(m.audioUrl, signed);
      for (const med of m.media ?? []) {
        if (med.url) med.url = this.privateMedia.resolve(med.url, signed);
      }
    }
    return plain;
  }

  /** Single-message variant of {@link decorateMessages} (the send response). */
  private async decorateMessage(msg: MessageDocument): Promise<Record<string, unknown>> {
    const [decorated] = await this.decorateMessages([msg]);
    return decorated;
  }

  /** Emit a context-thread activity signal (best-effort) so the owning module
   *  (e.g. inquiries) can sync its entity status without importing the inbox. */
  private emitThreadActivity(
    thread: ThreadDocument,
    actorId: string,
    kind: 'read' | 'reply',
  ): void {
    if (!thread.contextEntityType || !thread.contextEntityId) return;
    this.eventEmitter?.emit(CONNECT_INBOX_THREAD_ACTIVITY, {
      contextEntityType: thread.contextEntityType,
      contextEntityId: String(thread.contextEntityId),
      actorId,
      kind,
    });
  }

  // ── Threads ──────────────────────────────────────────────────────────────

  /** Find or lazily create a free 1:1 DM thread between two members. */
  async findOrCreateDmThread(meId: string, recipientId: string): Promise<ThreadDocument> {
    if (meId === recipientId) {
      throw new BadRequestException('You cannot message yourself.');
    }
    if (!Types.ObjectId.isValid(recipientId)) throw new NotFoundException('User not found');
    const recipient = await this.userModel
      .findById(recipientId)
      .select('_id isDemo email')
      .lean<{ _id: Types.ObjectId; isDemo?: boolean; email?: string } | null>()
      .exec();
    if (!recipient) throw new NotFoundException('User not found');

    await this.assertNotBlocked(meId, recipientId);
    const [a, b] = this.sortPair(meId, recipientId);
    const pairKey = `${a}:${b}:dm`;

    // Cold DM initiation (a brand-new thread) is the open-DM abuse vector, so it
    // is the only path rate-limited. Resuming an existing DM, replying, and
    // context threads (inquiry / application / quote = consent) are never limited.
    const existing = await this.threadModel.findOne({ pairKey }).exec();
    if (existing) return existing;

    // Demo isolation (DEMO-CONTENT-TRUST-UX-PLAN): a seeded sample account and a
    // real user may never START a DM with each other (either direction). Demo↔demo
    // and real↔real are fine. The marker is User.isDemo OR an @connect-demo email.
    // Placed AFTER the existing-thread early return so an established conversation
    // is never severed and the hot resume path skips the extra lookup. Cross-module:
    // reads User.
    await this.assertNoDemoCrossDm(meId, recipient);
    // Visibility gate (owner rule, 2026-06-20): only NEW-thread (cold) initiation is
    // gated -- an already-established conversation is never severed. A `public`
    // recipient is reachable by any signed-in member (the open-network default);
    // a `connections` / `hidden` recipient may be cold-messaged only by a first-degree
    // connection. The authoritative server gate behind the web button-hiding, so a
    // stale / hand-crafted request cannot bypass it. Cross-module: reads ConnectProfile
    // (visibility) + Connection (the edge).
    await this.assertRecipientReachable(meId, recipientId);
    await this.assertCanInitiate(meId);
    await this.spamGuard?.recordInitiation(meId);

    return this.upsertThread(pairKey, [a, b], 'dm', null, null);
  }

  /**
   * Block a DM between a seeded sample account and a real user (either direction).
   * The marker mirrors the rest of Connect (jobs.service / ad-repos): `User.isDemo`
   * OR an `@connect-demo.zari360.test` email. Demo↔demo and real↔real are allowed.
   * The recipient is already loaded by the caller; the initiator (`meId`) is fetched
   * here. Friendly `ForbiddenException` on a cross-demo attempt. Cross-module: User.
   */
  private async assertNoDemoCrossDm(
    meId: string,
    recipient: { isDemo?: boolean; email?: string },
  ): Promise<void> {
    const me = await this.userModel
      .findById(meId)
      .select('isDemo email')
      .lean<{ isDemo?: boolean; email?: string } | null>()
      .exec();
    const meDemo = InboxService.isDemoUser(me);
    const recipientDemo = InboxService.isDemoUser(recipient);
    if (meDemo !== recipientDemo) {
      throw new ForbiddenException(
        meDemo
          ? 'This is a sample account and cannot message real members.'
          : 'This is a sample profile shown as an example, so it cannot be messaged.',
      );
    }
  }

  /** Whether a user is a seeded demo/sample account (isDemo flag OR demo email). */
  private static isDemoUser(u: { isDemo?: boolean; email?: string } | null | undefined): boolean {
    if (!u) return false;
    return u.isDemo === true || (u.email ?? '').endsWith('@connect-demo.zari360.test');
  }

  /**
   * Throw `ForbiddenException` unless `meId` may COLD-message `recipientId` under the
   * recipient's profile visibility. `public` -> open to any member. `connections` /
   * `hidden` -> requires a first-degree connection. A recipient with NO ConnectProfile
   * is treated as `public` (legacy / not-yet-onboarded -> the historical open-DM
   * behaviour, so this adds no new lock-out). Skipped entirely when the profile model
   * is absent (positional unit-test construction) so existing inbox specs are
   * unchanged. Keep in sync with the web Message-button gating.
   */
  private async assertRecipientReachable(meId: string, recipientId: string): Promise<void> {
    if (!this.connectProfileModel) return;
    const profile = await this.connectProfileModel
      .findOne({ userId: new Types.ObjectId(recipientId) })
      .select('visibility')
      .lean<{ visibility?: string } | null>()
      .exec();
    const visibility = profile?.visibility ?? 'public';
    if (visibility === 'public') return;
    if (await this.areConnected(meId, recipientId)) return;
    throw new ForbiddenException('You can message this person after you connect with them.');
  }

  /**
   * Whether `a` and `b` are first-degree connected. Reads the single canonical
   * ordered-pair `Connection` row (NetworkService convention: `userA` = the
   * lexicographically-smaller id). Returns FALSE when the connection model is absent
   * so a non-public recipient stays unreachable (fail-closed: the gate's whole job is
   * to withhold the cold DM unless a connection is proven).
   */
  private async areConnected(a: string, b: string): Promise<boolean> {
    if (!this.connectionModel) return false;
    const x = new Types.ObjectId(a);
    const y = new Types.ObjectId(b);
    const [userA, userB] = x.toHexString() <= y.toHexString() ? [x, y] : [y, x];
    const row = await this.connectionModel
      .findOne({ userA, userB })
      .select('_id')
      .lean<{ _id: Types.ObjectId } | null>()
      .exec();
    return row !== null;
  }

  /** Find or lazily create a context thread bound to an inquiry / application / quote. */
  async findOrCreateContextThread(
    meId: string,
    recipientId: string,
    contextEntityType: InboxContextEntityType,
    contextEntityId: string,
  ): Promise<ThreadDocument> {
    if (meId === recipientId) {
      throw new BadRequestException('You cannot message yourself.');
    }
    if (!Types.ObjectId.isValid(recipientId) || !Types.ObjectId.isValid(contextEntityId)) {
      throw new NotFoundException('Not found');
    }
    await this.assertNotBlocked(meId, recipientId);
    const channel: InboxChannelType =
      contextEntityType === 'Inquiry'
        ? 'inquiry'
        : contextEntityType === 'JobApplication'
          ? 'application'
          : contextEntityType === 'CandidateRequest'
            ? 'candidate_request'
            : 'quote';
    const [a, b] = this.sortPair(meId, recipientId);
    return this.upsertThread(
      `${a}:${b}:${channel}:${contextEntityId}`,
      [a, b],
      channel,
      contextEntityType,
      contextEntityId,
    );
  }

  /** The caller's threads, newest-active first, optionally filtered by channel. */
  async listThreads(
    meId: string,
    channel?: InboxChannelType,
    before?: string,
  ): Promise<ThreadListItem[]> {
    const meObjId = new Types.ObjectId(meId);
    const query: Record<string, unknown> = { 'participants.userId': meObjId };
    if (channel) query.channelType = channel;
    if (before) {
      const cursor = new Date(before);
      if (!Number.isNaN(cursor.getTime())) query.lastActivityAt = { $lt: cursor };
    }
    const threads = await this.threadModel
      .find(query)
      .sort({ lastActivityAt: -1 })
      .limit(INBOX_THREAD_PAGE_SIZE)
      .lean<Array<Thread & { _id: Types.ObjectId }>>()
      .exec();
    return this.hydrateThreads(threads, meId);
  }

  /** A single thread (caller must be a participant). */
  async getThread(meId: string, threadId: string): Promise<ThreadListItem> {
    const thread = await this.loadParticipantThread(meId, threadId);
    const [hydrated] = await this.hydrateThreads(
      [thread.toObject() as Thread & { _id: Types.ObjectId }],
      meId,
    );
    return hydrated;
  }

  /**
   * Build the UNIFIED per-person timeline (the "contexts as inline messages"
   * view): gather every NON-system thread the caller shares with `otherId`,
   * emit one hydrated context-card item per context thread (reusing
   * hydrateContexts, so role-gating + the employer-only applicant snapshot leak
   * guard stay request-scoped on meId), interleave each thread's latest page of
   * messages, and sort the whole stream by wall-clock createdAt. Read-only,
   * additive; the DB stays one-thread-per-context. Consumed by the web
   * UnifiedConversationPane. Watch: per-thread seq is NOT a global order.
   */
  async buildPersonTimeline(meId: string, otherId: string): Promise<PersonTimeline> {
    if (!Types.ObjectId.isValid(otherId)) {
      throw new BadRequestException('Invalid user id');
    }
    const [a, b] = this.sortPair(meId, otherId);
    const threads = await this.threadModel
      .find({
        participantIds: { $all: [new Types.ObjectId(a), new Types.ObjectId(b)] },
        channelType: { $ne: 'system' },
      })
      .lean<Array<Thread & { _id: Types.ObjectId; createdAt?: Date }>>()
      .exec();
    if (threads.length === 0) return { party: null, items: [], threads: [] };

    // The other party, for the conversation header (name / avatar / handle).
    const otherUser = await this.userModel
      .findById(new Types.ObjectId(otherId))
      .select('name profilePicture handle isDemo')
      .lean<{
        _id: Types.ObjectId;
        name: string;
        profilePicture?: string;
        handle?: string | null;
        isDemo?: boolean;
      }>()
      .exec();
    const party: InboxParty | null = otherUser
      ? {
          userId: String(otherUser._id),
          name: otherUser.name,
          avatar: otherUser.profilePicture ?? null,
          handle: otherUser.handle ?? null,
          isDemo: otherUser.isDemo === true,
        }
      : null;

    // Reuse the existing per-kind hydration (keeps the leak guard + role gating).
    const contextByThread = await this.hydrateContexts(threads, meId);

    const items: PersonTimelineItem[] = [];
    const cursors: PersonTimeline['threads'] = [];

    // One context-card item per context thread, placed at the thread's creation.
    for (const t of threads) {
      const ctx = contextByThread.get(String(t._id));
      if (!ctx) continue;
      const when = t.createdAt ?? t.lastActivityAt;
      items.push({
        type: 'context',
        threadId: String(t._id),
        channelType: t.channelType,
        contextEntityId: t.contextEntityId ? String(t.contextEntityId) : null,
        context: ctx,
        createdAt: when ? new Date(when).toISOString() : '',
      });
    }

    // Each thread's latest page of messages, interleaved into the stream.
    for (const t of threads) {
      const msgs = await this.messageModel
        .find({ threadId: t._id, seq: { $gt: 0 } })
        .sort({ seq: -1 })
        .limit(INBOX_MESSAGE_PAGE_SIZE)
        .exec();
      const decorated = await this.decorateMessages(msgs);
      let newestSeq = 0;
      for (const m of decorated) {
        const seq = typeof m.seq === 'number' ? m.seq : 0;
        if (seq > newestSeq) newestSeq = seq;
        items.push({
          type: 'message',
          threadId: String(t._id),
          channelType: t.channelType,
          message: m,
          createdAt: m.createdAt
            ? new Date(m.createdAt as string | number | Date).toISOString()
            : '',
        });
      }
      // The other party's read watermark for THIS thread -> web read receipts.
      const otherParticipant = t.participants?.find((p) => String(p.userId) !== meId);
      const otherLastReadSeq = otherParticipant?.lastReadSeq ?? 0;
      cursors.push({
        threadId: String(t._id),
        channelType: t.channelType,
        newestSeq,
        otherLastReadSeq,
      });
    }

    // Merge by wall-clock createdAt; deterministic tie-break (threadId, then seq).
    items.sort((x, y) => {
      if (x.createdAt !== y.createdAt) return x.createdAt < y.createdAt ? -1 : 1;
      if (x.threadId !== y.threadId) return x.threadId < y.threadId ? -1 : 1;
      const sx = x.type === 'message' ? Number(x.message.seq ?? 0) : 0;
      const sy = y.type === 'message' ? Number(y.message.seq ?? 0) : 0;
      return sx - sy;
    });

    return { party, items, threads: cursors };
  }

  /** Page a thread's messages, newest-first, keyset by `seq`. */
  async listMessages(
    meId: string,
    threadId: string,
    beforeSeq?: number,
  ): Promise<Record<string, unknown>[]> {
    await this.loadParticipantThread(meId, threadId);
    const query: Record<string, unknown> = { threadId: new Types.ObjectId(threadId) };
    if (typeof beforeSeq === 'number') query.seq = { $lt: beforeSeq };
    const msgs = await this.messageModel
      .find(query)
      .sort({ seq: -1 })
      .limit(INBOX_MESSAGE_PAGE_SIZE)
      .exec();
    // Sign private attachment refs into 1h URLs before they leave the API.
    return this.decorateMessages(msgs);
  }

  // ── Send ─────────────────────────────────────────────────────────────────

  /**
   * Send a message into a thread. Atomic `seq` allocation + recipient unread
   * `$inc` + idempotent `clientMsgId`. The realtime emit is added in wave I2.
   */
  async sendMessage(
    senderId: string,
    threadId: string,
    dto: SendMessageDto,
  ): Promise<Record<string, unknown>> {
    const thread = await this.loadParticipantThread(senderId, threadId);
    if (thread.closed) throw new ForbiddenException('This conversation is closed.');
    if (thread.channelType === 'system') {
      throw new ForbiddenException('You cannot reply to a system message.');
    }
    const recipientId = this.otherParticipant(thread, senderId);
    if (!recipientId) throw new BadRequestException('This thread has no recipient.');
    await this.assertNotBlocked(senderId, recipientId);

    // Idempotent send: a retried clientMsgId returns the already-persisted row.
    const existing = await this.messageModel
      .findOne({ threadId: thread._id, clientMsgId: dto.clientMsgId })
      .exec();
    if (existing) return this.decorateMessage(existing);

    const kind: InboxMessageKind = dto.audioUrl
      ? 'voice'
      : dto.media && dto.media.length > 0
        ? 'photo'
        : 'text';
    const body = (dto.body ?? '').trim();
    if (kind === 'text' && body.length === 0) {
      throw new BadRequestException('Message is empty.');
    }

    // Enforce that every attachment (photo media + voice note) was uploaded by
    // this sender and lives on our storage -- calls the shared media-ownership
    // guard (assertOwnedMedia) before anything is persisted.
    const mediaUrls = [...(dto.media?.map((m) => m.url) ?? []), dto.audioUrl];
    await this.media.assertOwnedMedia(mediaUrls, senderId);

    // Voice notes: persist the SERVER-parsed clip length (probed at upload),
    // never the client's claimed `audioDurationSec`. Falls back to the client
    // value only for grandfathered clips with no probe on file. Mirrors the
    // feed voice-post override.
    const serverAudioDurationSec = await this.media.getServerAudioDurationByUrl(
      dto.audioUrl,
      senderId,
    );

    // Atomic seq alloc + recipient unread bump + activity bump, in one op.
    const recipientObjId = new Types.ObjectId(recipientId);
    const now = new Date();
    const updated = await this.threadModel
      .findOneAndUpdate(
        { _id: thread._id, 'participants.userId': recipientObjId },
        {
          $inc: { messageSeq: 1, 'participants.$.unreadCount': 1 },
          $set: { lastActivityAt: now },
        },
        { new: true },
      )
      .exec();
    if (!updated) throw new NotFoundException('Thread not found');
    const seq = updated.messageSeq;

    let message: MessageDocument;
    try {
      message = await this.messageModel.create({
        threadId: thread._id,
        senderUserId: new Types.ObjectId(senderId),
        kind,
        seq,
        body,
        media: (dto.media ?? []).map((m) => ({
          url: m.url,
          mime: m.mime,
          width: m.width ?? null,
          height: m.height ?? null,
          sizeBytes: m.sizeBytes ?? null,
          scanStatus: 'pending',
        })),
        audioUrl: dto.audioUrl ?? null,
        audioDurationSec: serverAudioDurationSec ?? dto.audioDurationSec ?? null,
        clientMsgId: dto.clientMsgId,
        seenBy: [],
      });
    } catch (err) {
      if (this.isDuplicateKeyError(err)) {
        const winner = await this.messageModel
          .findOne({ threadId: thread._id, clientMsgId: dto.clientMsgId })
          .exec();
        if (winner) return this.decorateMessage(winner);
      }
      Sentry.captureException(err, { tags: { module: 'connect.inbox', op: 'sendMessage' } });
      throw err;
    }

    await this.threadModel
      .updateOne(
        { _id: thread._id },
        {
          $set: {
            lastMessage: {
              messageId: message._id,
              senderUserId: new Types.ObjectId(senderId),
              preview: this.buildPreview(kind, body),
              kind,
              seq,
              createdAt: message.createdAt ?? now,
            },
          },
        },
      )
      .exec();

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Message',
      entityId: String(message._id),
      action: 'message_sent',
      actorId: senderId,
      meta: { threadId, channelType: thread.channelType, kind },
    });
    this.posthog?.capture({
      distinctId: senderId,
      event: 'connect.message_sent',
      properties: { threadId, channelType: thread.channelType, kind },
    });

    // Cold-contact spam scoring (I5b) -- best-effort, never blocks the send.
    void this.scoreColdContactForSpam(senderId, recipientId, thread, body).catch(() => undefined);

    // Realtime delivery (best-effort; the durable row + since-cursor catch-up
    // are the contract). Emit to both participants so the sender's other
    // devices stay in sync; nudge the recipient's thread-list row.
    this.gateway?.emitMessage([recipientId, senderId], {
      threadId,
      messageId: String(message._id),
      senderUserId: senderId,
      kind,
      body,
      seq,
      createdAt: (message.createdAt ?? now).toISOString(),
    });
    this.gateway?.emitThreadUpdated(recipientId, threadId);

    // Best-effort: light up the recipient's bell (mute suppresses it). Never
    // blocks the send -- dispatch self-catches.
    const muted = updated.participants.some((p) => String(p.userId) === recipientId && p.muted);
    if (!muted) {
      void this.dispatchMessageNotification(senderId, recipientId, thread, body, kind).catch(
        () => undefined,
      );
    }
    // Context-thread status sync (e.g. the seller replying to an inquiry -> "replied").
    this.emitThreadActivity(thread, senderId, 'reply');
    return this.decorateMessage(message);
  }

  // ── Read state ─────────────────────────────────────────────────────────────

  /**
   * Mark a thread read up to `upToSeq`. Monotonic + idempotent (a stale / older
   * seq is a no-op), and the residual unread is recomputed from the live
   * `messageSeq` so a message that landed concurrently is not zeroed away.
   */
  async markRead(meId: string, threadId: string, upToSeq: number): Promise<void> {
    const thread = await this.loadParticipantThread(meId, threadId);
    const meObjId = new Types.ObjectId(meId);
    const now = new Date();
    await this.threadModel
      .updateOne(
        {
          _id: thread._id,
          participants: { $elemMatch: { userId: meObjId, lastReadSeq: { $lt: upToSeq } } },
        },
        [
          {
            $set: {
              participants: {
                $map: {
                  input: '$participants',
                  as: 'p',
                  in: {
                    $cond: [
                      { $eq: ['$$p.userId', meObjId] },
                      {
                        $mergeObjects: [
                          '$$p',
                          {
                            lastReadSeq: upToSeq,
                            lastReadAt: now,
                            unreadCount: {
                              $max: [0, { $subtract: ['$messageSeq', upToSeq] }],
                            },
                          },
                        ],
                      },
                      '$$p',
                    ],
                  },
                },
              },
            },
          },
        ],
      )
      .exec();

    // Tell the other participant my read watermark moved (best-effort).
    const otherId = this.otherParticipant(thread, meId);
    if (otherId) {
      this.gateway?.emitRead([otherId], { threadId, readerUserId: meId, upToSeq });
    }
    // Context-thread status sync (e.g. the seller opening an inquiry -> "viewed").
    this.emitThreadActivity(thread, meId, 'read');
  }

  /**
   * Since-cursor catch-up for a reconnecting client: messages in a thread with
   * `seq > sinceSeq`, ascending, capped. Recovers anything missed while the
   * socket was down -- the durable store is the source of truth.
   */
  async messagesSince(
    meId: string,
    threadId: string,
    sinceSeq: number,
  ): Promise<Record<string, unknown>[]> {
    await this.loadParticipantThread(meId, threadId);
    const msgs = await this.messageModel
      .find({ threadId: new Types.ObjectId(threadId), seq: { $gt: sinceSeq } })
      .sort({ seq: 1 })
      .limit(INBOX_RESUME_MAX)
      .exec();
    // Sign private attachment refs into 1h URLs before they leave the API.
    return this.decorateMessages(msgs);
  }

  /** The caller's global unread total for the inbox nav badge (no message scan). */
  async getUnreadBadge(meId: string): Promise<{ total: number }> {
    const meObjId = new Types.ObjectId(meId);
    const rows = await this.threadModel
      .aggregate<{
        total: number;
      }>([
        { $match: { 'participants.userId': meObjId } },
        { $unwind: '$participants' },
        { $match: { 'participants.userId': meObjId, 'participants.archived': false } },
        { $group: { _id: null, total: { $sum: '$participants.unreadCount' } } },
      ])
      .exec();
    return { total: rows[0]?.total ?? 0 };
  }

  // ── Block / report (safety floor; enforcement deepens in I5) ──────────────

  async blockUser(meId: string, targetUserId: string): Promise<void> {
    if (meId === targetUserId) throw new BadRequestException('You cannot block yourself.');
    if (!Types.ObjectId.isValid(targetUserId)) throw new NotFoundException('User not found');
    await this.blockModel
      .updateOne(
        {
          blockerUserId: new Types.ObjectId(meId),
          blockedUserId: new Types.ObjectId(targetUserId),
        },
        { $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      )
      .exec();
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'UserBlock',
      entityId: targetUserId,
      action: 'message_block',
      actorId: meId,
    });
  }

  async unblockUser(meId: string, targetUserId: string): Promise<void> {
    await this.blockModel
      .deleteOne({
        blockerUserId: new Types.ObjectId(meId),
        blockedUserId: new Types.ObjectId(targetUserId),
      })
      .exec();
  }

  async reportThread(meId: string, threadId: string, dto: ReportThreadDto): Promise<void> {
    const thread = await this.loadParticipantThread(meId, threadId);
    const reportedUserId = this.otherParticipant(thread, meId);
    if (!reportedUserId) throw new BadRequestException('Nothing to report on this thread.');

    let snapshot = '';
    if (dto.messageId && Types.ObjectId.isValid(dto.messageId)) {
      const msg = await this.messageModel
        .findOne({ _id: new Types.ObjectId(dto.messageId), threadId: thread._id })
        .select('body')
        .lean<{ body?: string }>()
        .exec();
      snapshot = msg?.body ?? '';
    }
    await this.reportModel.create({
      reporterUserId: new Types.ObjectId(meId),
      reportedUserId: new Types.ObjectId(reportedUserId),
      threadId: thread._id,
      messageId: dto.messageId ? new Types.ObjectId(dto.messageId) : null,
      messageSnapshot: snapshot,
      reason: dto.reason,
      detail: dto.detail ?? '',
      status: 'open',
    });
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'InboxReport',
      entityId: threadId,
      action: 'message_report',
      actorId: meId,
      meta: { reportedUserId, reason: dto.reason },
    });
  }

  // ── System channel (platform-authored; used by I4 unification) ────────────

  /** Post a read-only system message to a member's System channel. */
  async postSystemMessage(userId: string, topic: string, body: string): Promise<MessageDocument> {
    const thread = await this.upsertThread(
      `${userId}:system:${topic}`,
      [userId],
      'system',
      null,
      null,
    );
    const updated = await this.threadModel
      .findOneAndUpdate(
        { _id: thread._id, 'participants.userId': new Types.ObjectId(userId) },
        {
          $inc: { messageSeq: 1, 'participants.$.unreadCount': 1 },
          $set: { lastActivityAt: new Date() },
        },
        { new: true },
      )
      .exec();
    const seq = updated?.messageSeq ?? 1;
    const message = await this.messageModel.create({
      threadId: thread._id,
      senderUserId: null,
      kind: 'system',
      seq,
      body,
      clientMsgId: `system:${topic}:${seq}`,
    });
    await this.threadModel
      .updateOne(
        { _id: thread._id },
        {
          $set: {
            lastMessage: {
              messageId: message._id,
              senderUserId: null,
              preview: this.buildPreview('system', body),
              kind: 'system',
              seq,
              createdAt: message.createdAt ?? new Date(),
            },
          },
        },
      )
      .exec();
    return message;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Sort a user-id pair ascending (the canonical-pair convention). */
  private sortPair(a: string, b: string): [string, string] {
    return a < b ? [a, b] : [b, a];
  }

  private otherParticipant(thread: ThreadDocument, meId: string): string | null {
    const other = thread.participantIds.find((id) => String(id) !== meId);
    return other ? String(other) : null;
  }

  /** Idempotent find-or-create on the canonical `pairKey`. */
  private async upsertThread(
    pairKey: string,
    participantIds: string[],
    channelType: InboxChannelType,
    contextEntityType: InboxContextEntityType | null,
    contextEntityId: string | null,
  ): Promise<ThreadDocument> {
    const existing = await this.threadModel.findOne({ pairKey }).exec();
    if (existing) return existing;
    const now = new Date();
    try {
      return await this.threadModel.create({
        pairKey,
        participantIds: participantIds.map((id) => new Types.ObjectId(id)),
        channelType,
        contextEntityType,
        contextEntityId: contextEntityId ? new Types.ObjectId(contextEntityId) : null,
        lastActivityAt: now,
        messageSeq: 0,
        participants: participantIds.map((id) => ({
          userId: new Types.ObjectId(id),
          unreadCount: 0,
          lastReadSeq: 0,
          lastReadMessageId: null,
          archived: false,
          muted: false,
          lastReadAt: null,
        })),
      });
    } catch (err) {
      if (this.isDuplicateKeyError(err)) {
        const winner = await this.threadModel.findOne({ pairKey }).exec();
        if (winner) return winner;
      }
      throw err;
    }
  }

  private async loadParticipantThread(meId: string, threadId: string): Promise<ThreadDocument> {
    if (!Types.ObjectId.isValid(threadId)) throw new NotFoundException('Thread not found');
    const thread = await this.threadModel.findById(threadId).exec();
    if (!thread || !thread.participantIds.some((id) => String(id) === meId)) {
      throw new NotFoundException('Thread not found');
    }
    return thread;
  }

  /** Throw if either user has blocked the other (open-DM safety floor). */
  private async assertNotBlocked(a: string, b: string): Promise<void> {
    const block = await this.blockModel
      .findOne({
        $or: [
          { blockerUserId: new Types.ObjectId(a), blockedUserId: new Types.ObjectId(b) },
          { blockerUserId: new Types.ObjectId(b), blockedUserId: new Types.ObjectId(a) },
        ],
      })
      .select('_id')
      .lean()
      .exec();
    if (block) {
      throw new ForbiddenException('You cannot message this person.');
    }
  }

  /**
   * Rate-limit a cold DM initiation by the sender's trust tier (open-DM safety,
   * I5). Best-effort: when the limiter is not wired (unit tests) it is skipped.
   * A denied initiation is a friendly 429 the client localizes.
   */
  private async assertCanInitiate(senderId: string): Promise<void> {
    // Spam auto-quarantine (I5b) blocks starting NEW cold threads only. Surfaced
    // as the same friendly 429 as the rate limit -- no "you are flagged" tell.
    if (this.spamGuard && (await this.spamGuard.isQuarantined(senderId))) {
      this.posthog?.capture({
        distinctId: senderId,
        event: 'connect.message_initiation_blocked',
        properties: { reason: 'quarantine' },
      });
      throw this.rateLimitedException();
    }
    if (!this.rateLimiter) return;
    const tier = await this.resolveSenderTier(senderId);
    const allowed = await this.rateLimiter.tryConsumeInitiation(senderId, tier);
    if (!allowed) {
      this.posthog?.capture({
        distinctId: senderId,
        event: 'connect.message_initiation_rate_limited',
        properties: { tier },
      });
      throw this.rateLimitedException();
    }
  }

  /** The friendly 429 used for both rate-limit and quarantine (invisible-first). */
  private rateLimitedException(): HttpException {
    return new HttpException(
      {
        code: 'MESSAGING_RATE_LIMITED',
        message: 'You are reaching out to new people too quickly. Please try again later.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * Score a cold first-contact DM for spam (I5b). Best-effort + non-blocking: a
   * scoring failure never affects the delivered message. On a high score the
   * sender is auto-quarantined from starting NEW cold threads (existing chats +
   * replies keep working); it never bans.
   */
  private async scoreColdContactForSpam(
    senderId: string,
    recipientId: string,
    thread: ThreadDocument,
    body: string,
  ): Promise<void> {
    if (!this.spamGuard || thread.channelType !== 'dm') return;
    // Only the cold opening counts: once the recipient has replied it is a real
    // conversation and is never scored.
    const recipientReplied = await this.messageModel
      .exists({ threadId: thread._id, senderUserId: new Types.ObjectId(recipientId) })
      .exec();
    if (recipientReplied) return;

    const duplicateBodyCount = await this.spamGuard.recordAndCountDuplicateBody(senderId, body);
    const initiationCount = await this.spamGuard.getInitiationCount(senderId);
    const openReportCount = await this.reportModel
      .countDocuments({ reportedUserId: new Types.ObjectId(senderId), status: 'open' })
      .exec();

    const { score, signals } = scoreColdContact({
      body,
      duplicateBodyCount,
      initiationCount,
      openReportCount,
    });
    const action = decideSpamAction(score);
    if (action === 'allow') return;

    this.logger.warn(
      `cold-contact spam score ${score} (${action}) for ${senderId}: ${signals.join(',')}`,
    );
    this.posthog?.capture({
      distinctId: senderId,
      event: 'connect.message_spam_scored',
      properties: { action, score, signals },
    });
    if (action === 'quarantine') {
      await this.spamGuard.quarantine(senderId);
      await this.audit.logEvent({
        module: AppModule.CONNECT,
        entityType: 'User',
        entityId: senderId,
        action: 'message_spam_quarantine',
        actorId: senderId,
        meta: { score, signals },
      });
    }
  }

  /** New (<7d) < Established (>=7d) < Verified (GST / ERP-linked badge). */
  private async resolveSenderTier(senderId: string): Promise<MessagingTier> {
    const user = await this.userModel
      .findById(senderId)
      .select('createdAt')
      .lean<{ createdAt?: Date }>()
      .exec();
    let verified = false;
    if (this.allowances) {
      try {
        verified = (await this.allowances.getAllowances(senderId)).verifiedBadge;
      } catch {
        verified = false; // fail to the most restrictive tier input
      }
    }
    return resolveMessagingTier({ createdAt: user?.createdAt ?? null, verified, now: new Date() });
  }

  private buildPreview(kind: InboxMessageKind, body: string): string {
    // Text + system keep their (capped) body; media-only previews are derived
    // from `kind` on the web so the label localizes.
    if (kind === 'text' || kind === 'system') {
      return body.slice(0, INBOX_PREVIEW_MAX);
    }
    return body ? body.slice(0, INBOX_PREVIEW_MAX) : '';
  }

  private async hydrateThreads(
    threads: Array<Thread & { _id: Types.ObjectId }>,
    meId: string,
  ): Promise<ThreadListItem[]> {
    if (threads.length === 0) return [];
    const partyIds = [
      ...new Set(
        threads
          .flatMap((t) => t.participantIds.map((id) => String(id)))
          .filter((id) => id !== meId),
      ),
    ].map((id) => new Types.ObjectId(id));

    const users = await this.userModel
      .find({ _id: { $in: partyIds } })
      // isDemo: tag a sample account in the thread list. See DEMO-CONTENT-TRUST-UX-PLAN.md.
      .select('name profilePicture handle isDemo')
      .lean<LeanUserSummary[]>()
      .exec();
    const userMap = new Map<string, InboxParty>(
      users.map((u) => [
        String(u._id),
        {
          userId: String(u._id),
          name: u.name,
          avatar: u.profilePicture ?? null,
          handle: u.handle ?? null,
          isDemo: u.isDemo === true,
        },
      ]),
    );

    // Subject-card context per thread (inquiry/application/quote), batched.
    // meId drives viewer-role gating (employer/applicant, buyer/supplier) + the
    // employer-only applicant snapshot.
    const contextByThread = await this.hydrateContexts(threads, meId);

    return threads.map((t) => {
      const me = t.participants.find((p) => String(p.userId) === meId);
      const otherId = t.participantIds.map((id) => String(id)).find((id) => id !== meId) ?? null;
      return {
        _id: String(t._id),
        channelType: t.channelType,
        contextEntityType: t.contextEntityType,
        contextEntityId: t.contextEntityId ? String(t.contextEntityId) : null,
        context: contextByThread.get(String(t._id)) ?? null,
        party: otherId ? (userMap.get(otherId) ?? null) : null,
        lastMessage: t.lastMessage
          ? {
              preview: t.lastMessage.preview,
              kind: t.lastMessage.kind,
              senderUserId: t.lastMessage.senderUserId ? String(t.lastMessage.senderUserId) : null,
              seq: t.lastMessage.seq,
              createdAt: t.lastMessage.createdAt
                ? new Date(t.lastMessage.createdAt).toISOString()
                : '',
            }
          : null,
        lastActivityAt: t.lastActivityAt ? new Date(t.lastActivityAt).toISOString() : '',
        unreadCount: me?.unreadCount ?? 0,
        archived: me?.archived ?? false,
        muted: me?.muted ?? false,
        closed: t.closed,
      };
    });
  }

  /**
   * Resolve what each context thread is ABOUT, batched per kind (no per-thread
   * query). Returns `threadId -> ThreadContext`; a thread whose source entity OR
   * its parent (listing / job / rfq) was deleted is simply ABSENT (the web then
   * renders the lean fallback). dm / system threads contribute nothing.
   *  - inquiry           -> Inquiry -> Listing                  (product card; template)
   *  - application       -> JobApplication -> Job (+CompanyPage) (job card)
   *  - quote             -> Quote -> Rfq                         (RFQ card)
   *  - candidate_request -> CandidateRequest -> CompanyPage      (institute hire-lead card)
   * Each branch issues a FIXED number of finds regardless of page size and runs
   * only when that channel appears on the page.
   */
  private async hydrateContexts(
    threads: Array<Thread & { _id: Types.ObjectId }>,
    meId: string,
  ): Promise<Map<string, ThreadContext>> {
    const result = new Map<string, ThreadContext>();
    await this.hydrateInquiryContexts(threads, result);
    await this.hydrateApplicationContexts(threads, result, meId);
    await this.hydrateQuoteContexts(threads, result, meId);
    await this.hydrateCandidateRequestContexts(threads, result);
    return result;
  }

  /** inquiry -> listing product card (the original/template branch). */
  private async hydrateInquiryContexts(
    threads: Array<Thread & { _id: Types.ObjectId }>,
    result: Map<string, ThreadContext>,
  ): Promise<void> {
    const inquiryThreads = threads.filter(
      (t) => t.contextEntityType === 'Inquiry' && t.contextEntityId,
    );
    if (inquiryThreads.length === 0) return;

    const inquiryIds = [...new Set(inquiryThreads.map((t) => String(t.contextEntityId)))].map(
      (id) => new Types.ObjectId(id),
    );
    const inquiries = await this.inquiryModel
      .find({ _id: { $in: inquiryIds } })
      .select('listingId status')
      .lean<Array<{ _id: Types.ObjectId; listingId: Types.ObjectId; status?: InquiryStatus }>>()
      .exec();
    const inquiryById = new Map(inquiries.map((i) => [String(i._id), i]));

    const listingIds = [...new Set(inquiries.map((i) => String(i.listingId)))].map(
      (id) => new Types.ObjectId(id),
    );
    if (listingIds.length === 0) return;
    const listings = await this.listingModel
      .find({ _id: { $in: listingIds } })
      .select('title images priceType priceMin priceMax unit moq')
      .lean<
        Array<{
          _id: Types.ObjectId;
          title: string;
          images?: string[];
          priceType: ListingPriceType;
          priceMin?: number | null;
          priceMax?: number | null;
          unit?: string | null;
          moq?: number | null;
        }>
      >()
      .exec();
    const listingMap = new Map(listings.map((l) => [String(l._id), l]));

    for (const t of inquiryThreads) {
      const inquiry = inquiryById.get(String(t.contextEntityId));
      const listing = inquiry ? listingMap.get(String(inquiry.listingId)) : undefined;
      if (!listing) continue;
      result.set(String(t._id), {
        kind: 'inquiry',
        listingId: String(listing._id),
        title: listing.title,
        coverImage: listing.images?.[0] ?? null,
        priceType: listing.priceType,
        priceMin: listing.priceMin ?? null,
        priceMax: listing.priceMax ?? null,
        unit: listing.unit ?? null,
        moq: listing.moq ?? null,
        status: inquiry?.status ?? null,
      });
    }
  }

  /** application -> the Job (+ optional company page) the application is for.
   *  When the viewer is the EMPLOYER (meId === job.companyUserId), also attaches
   *  a public-facts applicant snapshot (headline / matched skills / district /
   *  past-applicant). The applicant's own view never gets the snapshot. */
  private async hydrateApplicationContexts(
    threads: Array<Thread & { _id: Types.ObjectId }>,
    result: Map<string, ThreadContext>,
    meId: string,
  ): Promise<void> {
    const appThreads = threads.filter(
      (t) => t.contextEntityType === 'JobApplication' && t.contextEntityId,
    );
    if (appThreads.length === 0 || !this.jobApplicationModel || !this.jobModel) return;

    const appIds = [...new Set(appThreads.map((t) => String(t.contextEntityId)))].map(
      (id) => new Types.ObjectId(id),
    );
    const apps = await this.jobApplicationModel
      .find({ _id: { $in: appIds } })
      // PRIVATE fields (resumeUrl / voiceNoteUrl) are deliberately NOT selected -
      // they never belong on the chat header (leak guard, see ThreadContext doc).
      // applicantUserId is needed for viewer-role + the employer-only snapshot.
      .select('jobId applicantUserId status viewedAt')
      .lean<
        Array<{
          _id: Types.ObjectId;
          jobId: Types.ObjectId;
          applicantUserId: Types.ObjectId;
          status: ApplicationStatus;
          viewedAt?: Date | null;
        }>
      >()
      .exec();
    const appById = new Map(apps.map((a) => [String(a._id), a]));

    const jobIds = [...new Set(apps.map((a) => String(a.jobId)))].map(
      (id) => new Types.ObjectId(id),
    );
    if (jobIds.length === 0) return;
    const jobs = await this.jobModel
      // companyUserId = the employer (viewer-role); skills = the skill-match base.
      .find({ _id: { $in: jobIds } })
      .select('title wageType wageMin wageMax location status companyPageId companyUserId skills')
      .lean<
        Array<{
          _id: Types.ObjectId;
          title: string;
          wageType?: JobWageType | null;
          wageMin?: number | null;
          wageMax?: number | null;
          location?: { district?: string } | null;
          status: JobStatus;
          companyPageId?: Types.ObjectId | null;
          companyUserId: Types.ObjectId;
          skills?: string[];
        }>
      >()
      .exec();
    const jobMap = new Map(jobs.map((j) => [String(j._id), j]));

    // Optional company-page identity (name + logo) for jobs posted AS a page.
    const pageIds = [
      ...new Set(
        jobs.map((j) => (j.companyPageId ? String(j.companyPageId) : null)).filter(Boolean),
      ),
    ].map((id) => new Types.ObjectId(id));
    const pageMap = new Map<string, { name: string; logo?: string }>();
    if (pageIds.length > 0 && this.companyPageModel) {
      const pages = await this.companyPageModel
        .find({ _id: { $in: pageIds } })
        .select('name logo')
        .lean<Array<{ _id: Types.ObjectId; name: string; logo?: string }>>()
        .exec();
      for (const p of pages) pageMap.set(String(p._id), { name: p.name, logo: p.logo });
    }

    // ── Employer-only applicant snapshot (batched) ────────────────────────────
    // Only for threads the viewer OWNS the job on. The applicant's own threads
    // never enter this set, so the snapshot can never leak to the applicant.
    const employerThreads = appThreads.filter((t) => {
      const app = appById.get(String(t.contextEntityId));
      const job = app ? jobMap.get(String(app.jobId)) : undefined;
      return !!job && String(job.companyUserId) === meId;
    });
    const profileByApplicant = new Map<
      string,
      { headline: string | null; skills: string[]; district: string | null }
    >();
    const pastApplicantSet = new Set<string>();
    if (employerThreads.length > 0 && this.connectProfileModel) {
      const applicantIds = [
        ...new Set(
          employerThreads
            .map((t) => appById.get(String(t.contextEntityId))?.applicantUserId)
            .filter(Boolean)
            .map((id) => String(id)),
        ),
      ];
      const applicantObjIds = applicantIds.map((id) => new Types.ObjectId(id));
      // Public profile facts only (same fields the applicant's public /u/[id] shows).
      const profiles = await this.connectProfileModel
        .find({ userId: { $in: applicantObjIds } })
        .select('userId headline skills district')
        .lean<
          Array<{ userId: Types.ObjectId; headline?: string; skills?: string[]; district?: string }>
        >()
        .exec();
      for (const p of profiles) {
        profileByApplicant.set(String(p.userId), {
          headline: p.headline?.trim() || null,
          skills: p.skills ?? [],
          district: p.district?.trim() || null,
        });
      }
      // Past applicant: applied to MORE THAN ONE of this employer's jobs (the
      // current one is always counted, so >1 == a repeat). Two bounded finds.
      const employerJobs = await this.jobModel
        .find({ companyUserId: new Types.ObjectId(meId) })
        .select('_id')
        .lean<Array<{ _id: Types.ObjectId }>>()
        .exec();
      const employerJobIds = employerJobs.map((j) => j._id);
      if (employerJobIds.length > 0) {
        const priorApps = await this.jobApplicationModel
          .find({ applicantUserId: { $in: applicantObjIds }, jobId: { $in: employerJobIds } })
          .select('applicantUserId')
          .lean<Array<{ applicantUserId: Types.ObjectId }>>()
          .exec();
        const countByApplicant = new Map<string, number>();
        for (const pa of priorApps) {
          const k = String(pa.applicantUserId);
          countByApplicant.set(k, (countByApplicant.get(k) ?? 0) + 1);
        }
        for (const [k, n] of countByApplicant) if (n > 1) pastApplicantSet.add(k);
      }
    }

    for (const t of appThreads) {
      const app = appById.get(String(t.contextEntityId));
      const job = app ? jobMap.get(String(app.jobId)) : undefined;
      if (!app || !job) continue;
      const page = job.companyPageId ? pageMap.get(String(job.companyPageId)) : undefined;
      const viewerIsEmployer = String(job.companyUserId) === meId;

      let applicant: ApplicantSnapshot | null = null;
      if (viewerIsEmployer) {
        const snap = profileByApplicant.get(String(app.applicantUserId));
        const applicantSkills = new Set((snap?.skills ?? []).map((s) => s.toLowerCase()));
        // Keep the job's original skill casing for display; match case-insensitively.
        const matchedSkills = (job.skills ?? []).filter((s) =>
          applicantSkills.has(s.toLowerCase()),
        );
        applicant = {
          headline: snap?.headline ?? null,
          matchedSkills,
          jobSkillCount: (job.skills ?? []).length,
          district: snap?.district ?? null,
          pastApplicant: pastApplicantSet.has(String(app.applicantUserId)),
        };
      }

      result.set(String(t._id), {
        kind: 'application',
        jobId: String(job._id),
        title: job.title,
        companyName: page?.name ?? null,
        companyLogo: page?.logo || null,
        wageType: job.wageType ?? null,
        wageMin: job.wageMin ?? null,
        wageMax: job.wageMax ?? null,
        district: job.location?.district || null,
        status: app.status,
        viewed: app.viewedAt != null,
        jobStatus: job.status,
        viewerRole: viewerIsEmployer ? 'employer' : 'applicant',
        applicant,
      });
    }
  }

  /** quote -> the Rfq the quote answers (RFQ card). viewerRole = buyer (owns the
   *  RFQ) vs supplier (owns the quote), driving the inline actions. */
  private async hydrateQuoteContexts(
    threads: Array<Thread & { _id: Types.ObjectId }>,
    result: Map<string, ThreadContext>,
    meId: string,
  ): Promise<void> {
    const quoteThreads = threads.filter(
      (t) => t.contextEntityType === 'Quote' && t.contextEntityId,
    );
    if (quoteThreads.length === 0 || !this.quoteModel || !this.rfqModel) return;

    const quoteIds = [...new Set(quoteThreads.map((t) => String(t.contextEntityId)))].map(
      (id) => new Types.ObjectId(id),
    );
    const quotes = await this.quoteModel
      .find({ _id: { $in: quoteIds } })
      // Only THIS thread's quote is surfaced (never sibling sellers' quotes).
      .select('rfqId price sampleUrls status')
      .lean<
        Array<{
          _id: Types.ObjectId;
          rfqId: Types.ObjectId;
          price?: number | null;
          sampleUrls?: string[];
          status: QuoteStatus;
        }>
      >()
      .exec();
    const quoteById = new Map(quotes.map((q) => [String(q._id), q]));

    const rfqIds = [...new Set(quotes.map((q) => String(q.rfqId)))].map(
      (id) => new Types.ObjectId(id),
    );
    if (rfqIds.length === 0) return;
    const rfqs = await this.rfqModel
      // buyerUserId = the RFQ owner, for viewer-role (buyer vs supplier).
      .find({ _id: { $in: rfqIds } })
      .select('title quantity unit budgetMin budgetMax location status buyerUserId')
      .lean<
        Array<{
          _id: Types.ObjectId;
          title: string;
          quantity?: number | null;
          unit?: string | null;
          budgetMin?: number | null;
          budgetMax?: number | null;
          location?: { district?: string } | null;
          status: RfqStatus;
          buyerUserId: Types.ObjectId;
        }>
      >()
      .exec();
    const rfqMap = new Map(rfqs.map((r) => [String(r._id), r]));

    for (const t of quoteThreads) {
      const quote = quoteById.get(String(t.contextEntityId));
      const rfq = quote ? rfqMap.get(String(quote.rfqId)) : undefined;
      if (!quote || !rfq) continue;
      result.set(String(t._id), {
        kind: 'quote',
        rfqId: String(rfq._id),
        title: rfq.title,
        sampleImage: quote.sampleUrls?.[0] ?? null,
        price: quote.price ?? null,
        quantity: rfq.quantity ?? null,
        unit: rfq.unit ?? null,
        budgetMin: rfq.budgetMin ?? null,
        budgetMax: rfq.budgetMax ?? null,
        district: rfq.location?.district || null,
        status: quote.status,
        rfqStatus: rfq.status,
        viewerRole: String(rfq.buyerUserId) === meId ? 'buyer' : 'supplier',
      });
    }
  }

  /**
   * candidate_request -> the institute CompanyPage a business pitched (Institutes
   * Phase 2, Feature 4). Batched: one $in over CandidateRequest by id, then one
   * $in over CompanyPage (the institute identity) + one $in over User (the business
   * sender's display name). A thread whose CandidateRequest OR its CompanyPage was
   * deleted is simply ABSENT from the map (same deleted-entity contract as the
   * inquiry/quote branches: the web then renders the lean fallback). Runs only when
   * a candidate_request thread is on the page AND the read-only model is wired
   * (it is @Optional in the constructor for the positional unit tests). No
   * viewer-role gating: the institute owner is always the recipient of the lead.
   */
  private async hydrateCandidateRequestContexts(
    threads: Array<Thread & { _id: Types.ObjectId }>,
    result: Map<string, ThreadContext>,
  ): Promise<void> {
    const leadThreads = threads.filter(
      (t) => t.contextEntityType === 'CandidateRequest' && t.contextEntityId,
    );
    if (leadThreads.length === 0 || !this.candidateRequestModel) return;

    const leadIds = [...new Set(leadThreads.map((t) => String(t.contextEntityId)))].map(
      (id) => new Types.ObjectId(id),
    );
    const leads = await this.candidateRequestModel
      .find({ _id: { $in: leadIds } })
      .select('companyPageId fromUserId status message')
      .lean<
        Array<{
          _id: Types.ObjectId;
          companyPageId: Types.ObjectId;
          fromUserId: Types.ObjectId;
          status: CandidateRequestStatus;
          message?: string;
        }>
      >()
      .exec();
    const leadById = new Map(leads.map((l) => [String(l._id), l]));

    // The institute page identity (name / slug / logo) for the card.
    const pageIds = [...new Set(leads.map((l) => String(l.companyPageId)))].map(
      (id) => new Types.ObjectId(id),
    );
    const pageMap = new Map<string, { name: string; slug?: string; logo?: string }>();
    if (pageIds.length > 0 && this.companyPageModel) {
      const pages = await this.companyPageModel
        .find({ _id: { $in: pageIds } })
        .select('name slug logo')
        .lean<Array<{ _id: Types.ObjectId; name: string; slug?: string; logo?: string }>>()
        .exec();
      for (const p of pages)
        pageMap.set(String(p._id), { name: p.name, slug: p.slug, logo: p.logo });
    }

    // The business sender's display name for the card.
    const fromIds = [...new Set(leads.map((l) => String(l.fromUserId)))].map(
      (id) => new Types.ObjectId(id),
    );
    const userMap = new Map<string, string>();
    if (fromIds.length > 0) {
      const users = await this.userModel
        .find({ _id: { $in: fromIds } })
        .select('name')
        .lean<Array<{ _id: Types.ObjectId; name?: string }>>()
        .exec();
      for (const u of users) userMap.set(String(u._id), u.name ?? '');
    }

    for (const t of leadThreads) {
      const lead = leadById.get(String(t.contextEntityId));
      const page = lead ? pageMap.get(String(lead.companyPageId)) : undefined;
      // A missing lead OR a deleted institute page -> omit (deleted-entity contract).
      if (!lead || !page) continue;
      result.set(String(t._id), {
        kind: 'candidate_request',
        candidateRequestId: String(lead._id),
        pageId: String(lead.companyPageId),
        pageName: page.name,
        pageSlug: page.slug ?? null,
        pageLogo: page.logo || null,
        fromUserName: userMap.get(String(lead.fromUserId))?.trim() || null,
        status: lead.status,
        messageSnippet: (lead.message ?? '').slice(0, INBOX_PREVIEW_MAX),
      });
    }
  }

  /**
   * Map each given context entity id to its thread id (or absent when no thread
   * exists yet). Used by the inquiry list to deep-link a row straight to its
   * conversation. Read-only; no participant check (the caller owns the entities).
   */
  async getThreadIdsForContext(
    contextEntityType: InboxContextEntityType,
    contextEntityIds: string[],
  ): Promise<Map<string, string>> {
    const ids = contextEntityIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (ids.length === 0) return new Map();
    const threads = await this.threadModel
      .find({ contextEntityType, contextEntityId: { $in: ids } })
      .select('_id contextEntityId')
      .lean<Array<{ _id: Types.ObjectId; contextEntityId: Types.ObjectId }>>()
      .exec();
    return new Map(threads.map((t) => [String(t.contextEntityId), String(t._id)]));
  }

  private async dispatchMessageNotification(
    senderId: string,
    recipientId: string,
    thread: ThreadDocument,
    body: string,
    kind: InboxMessageKind,
  ): Promise<void> {
    const sender = await this.userModel
      .findById(senderId)
      .select('name')
      .lean<{ name?: string }>()
      .exec();
    const name = sender?.name?.trim() || 'Someone';
    const preview = kind === 'text' ? body.slice(0, 100) : `${name} sent a ${kind}`;
    await this.notifications?.dispatch({
      recipientId,
      actorId: new Types.ObjectId(senderId),
      category: 'connect.message_received',
      entityType: 'Thread',
      entityId: String(thread._id),
      title: `Message from ${name}`,
      message: preview,
    });
  }

  private isDuplicateKeyError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    return (err as { code?: number }).code === DUPLICATE_KEY_ERROR;
  }
}
