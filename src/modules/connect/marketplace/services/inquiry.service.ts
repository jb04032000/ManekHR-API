import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { FilterQuery, Model, Types } from 'mongoose';
import * as Sentry from '@sentry/nestjs';
import {
  buildPage,
  clampPageSize,
  decodeCursor,
  keysetFilter,
  type KeysetRow,
} from '../../common/keyset-cursor';
import { Inquiry, type InquiryDocument, type InquiryStatus } from '../schemas/inquiry.schema';
import { Listing, type ListingDocument, type ListingStatus } from '../schemas/listing.schema';
import { User } from '../../../users/schemas/user.schema';
import { ConnectAllowanceService } from '../../monetization/connect-allowance.service';
import { AuditService } from '../../../audit/audit.service';
import { AppModule } from '../../../../common/enums/modules.enum';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { NotificationsService } from '../../../notifications/notifications.service';
import { InboxService } from '../../inbox/inbox.service';
import {
  CONNECT_INBOX_THREAD_ACTIVITY,
  type InboxThreadActivityEvent,
} from '../../inbox/inbox.events';

export interface CreateInquiryInput {
  message?: string;
}

/** The other party on an inquiry (the seller for a buyer's outbox, the buyer for a seller's inbox). */
export interface InquiryParty {
  userId: string;
  name: string;
  avatar: string | null;
  handle: string | null;
}

/** A compact listing summary for an inquiry row. `null` when the listing was deleted. */
export interface InquiryListingSummary {
  listingId: string;
  title: string;
  coverImage: string | null;
  status: ListingStatus;
}

/** A hydrated inquiry row for the M1.6 inbox / outbox UI. */
export interface InquiryListItem {
  _id: string;
  listingId: string;
  buyerUserId: string;
  sellerUserId: string;
  message: string;
  status: InquiryStatus;
  createdAt: string;
  updatedAt: string;
  listing: InquiryListingSummary | null;
  party: InquiryParty | null;
  /** The unified-inbox thread this inquiry seeded, so a row deep-links to chat. */
  threadId: string | null;
}

/** One keyset page of inquiry rows (envelope mirrors the feed/comments style). */
export interface InquiryListPage {
  items: InquiryListItem[];
  /** Pass back as `?cursor=` for the next (older) page; `null` when caught up. */
  nextCursor: string | null;
}

/** Minimal lean shapes the hydration reads (no Mongoose document overhead). */
interface LeanInquiry {
  _id: Types.ObjectId;
  listingId: Types.ObjectId;
  buyerUserId: Types.ObjectId;
  sellerUserId: Types.ObjectId;
  message: string;
  status: InquiryStatus;
  createdAt?: Date;
  updatedAt?: Date;
}
interface LeanListingSummary {
  _id: Types.ObjectId;
  title: string;
  images?: string[];
  status: ListingStatus;
}
interface LeanUserSummary {
  _id: Types.ObjectId;
  name: string;
  profilePicture?: string;
  handle?: string | null;
}

/** Mongo duplicate-key error code, raised when the unique compound index fires. */
const DUPLICATE_KEY_ERROR = 11000;

/**
 * Compute the first instant of the current calendar month (server local time).
 * The cycle window is intentionally simple in M1.5: a calendar month. M2 can
 * refine to a subscription-anchored cycle (start at billing-period boundary)
 * once the seller dashboard wants exact "leads used this billing cycle" copy.
 */
function startOfCurrentCycle(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/**
 * ManekHR Connect Marketplace -- inquiry / lead metering (Phase M1.5).
 *
 * A buyer expresses interest in a listing -> the platform persists an
 * `Inquiry` row -> the seller sees it on their inbox (M1.6). The
 * Road-A mediator model means the platform never carries payment or chat;
 * the inquiry is purely a lead signal.
 *
 * Business rules:
 *
 *   1. **Self-inquiry blocked.** A seller cannot send an inquiry to their own
 *      listing -- guards against an accidental loop on the seller dashboard
 *      and stops a vanity-inflate of someone's lead count.
 *   2. **Public listing only.** A buyer can only inquire on an `active` +
 *      `approved` listing. Draft / pending / rejected / paused / expired all
 *      404 (no existence leak).
 *   3. **One inquiry per buyer per listing.** Compound unique index on
 *      `{listingId, buyerUserId}` enforces dedupe at the DB; the service
 *      catches the `E11000` and returns the existing row so the UX is a
 *      clean idempotent "you already inquired about this".
 *   4. **Seller-side lead cap.** Before persisting, count the seller's
 *      inquiries this cycle and route through
 *      `ConnectAllowanceService.canUseLead`. At the cap, throw
 *      `CONNECT_SELLER_LEAD_CAP_REACHED` (a 403) so the buyer sees a clear
 *      "this seller is fully booked" message rather than a silent drop.
 */
@Injectable()
export class InquiryService {
  private readonly logger = new Logger(InquiryService.name);

  constructor(
    @InjectModel(Inquiry.name)
    private readonly inquiryModel: Model<InquiryDocument>,
    @InjectModel(Listing.name)
    private readonly listingModel: Model<ListingDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    private readonly allowances: ConnectAllowanceService,
    private readonly audit: AuditService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
    @Optional()
    @Inject(NotificationsService)
    private readonly notifications?: NotificationsService,
    // The unified Inbox: an inquiry is seeded as an inbox thread so the seller
    // replies in one place. @Optional so unit tests can omit it.
    @Optional() @Inject(InboxService) private readonly inbox?: InboxService,
  ) {}

  /**
   * Surface an inquiry in the Inbox (the unified messaging hub): find-or-create
   * the context thread + seed the buyer's message. Idempotent (the thread
   * pairKey + the `inquiry-<id>` clientMsgId), so the dedupe path can re-run it
   * to self-heal a missing thread. Non-fatal: a messaging error logs but never
   * fails the lead capture. Context threads skip spam/quarantine + rate limits.
   */
  private async seedInboxThread(
    buyerUserId: string,
    sellerUserId: string,
    inquiryId: string,
    message: string,
  ): Promise<string | null> {
    if (!this.inbox) return null;
    try {
      const thread = await this.inbox.findOrCreateContextThread(
        buyerUserId,
        sellerUserId,
        'Inquiry',
        inquiryId,
      );
      const body = (message ?? '').trim();
      if (body) {
        await this.inbox.sendMessage(buyerUserId, String(thread._id), {
          body,
          clientMsgId: `inquiry-${inquiryId}`,
        });
      }
      return String(thread._id);
    } catch (e) {
      this.logger.warn(
        `inbox seed failed for inquiry ${inquiryId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /**
   * Sync the inquiry status from inbox activity (decoupled via the global
   * EventEmitter; the inbox never imports this module). Only the SELLER's
   * activity advances the status: opening the thread -> `viewed`; replying ->
   * `replied`. Best-effort + idempotent (no-op once already advanced).
   */
  @OnEvent(CONNECT_INBOX_THREAD_ACTIVITY)
  async onInboxThreadActivity(ev: InboxThreadActivityEvent): Promise<void> {
    if (ev.contextEntityType !== 'Inquiry' || !Types.ObjectId.isValid(ev.contextEntityId)) return;
    try {
      const inquiry = await this.inquiryModel.findById(ev.contextEntityId);
      if (!inquiry || ev.actorId !== String(inquiry.sellerUserId)) return;
      if (ev.kind === 'read' && inquiry.status === 'sent') {
        inquiry.status = 'viewed';
        await inquiry.save();
      } else if (
        ev.kind === 'reply' &&
        (inquiry.status === 'sent' || inquiry.status === 'viewed')
      ) {
        inquiry.status = 'replied';
        await inquiry.save();
      }
    } catch (e) {
      this.logger.warn(
        `inquiry status sync failed for ${ev.contextEntityId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Create an inquiry for the authenticated buyer on the given listing.
   * Enforces the four business rules; returns the existing row on a duplicate
   * so the call is idempotent from the buyer's perspective.
   */
  async create(
    buyerUserId: string,
    listingId: string,
    input: CreateInquiryInput,
  ): Promise<InquiryDocument> {
    if (!Types.ObjectId.isValid(listingId)) {
      throw new NotFoundException('Listing not found');
    }
    const buyerObjectId = new Types.ObjectId(buyerUserId);
    const listingObjectId = new Types.ObjectId(listingId);

    // Public gate: only an `active` + `approved` listing can receive an
    // inquiry. Anything else 404s (no existence leak for draft / paused /
    // rejected listings).
    const listing = await this.listingModel
      .findOne({ _id: listingObjectId, status: 'active', moderationStatus: 'approved' })
      .lean<Listing & { _id: Types.ObjectId; ownerUserId: Types.ObjectId }>()
      .exec();
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    const sellerUserId = String(listing.ownerUserId);

    if (sellerUserId === buyerUserId) {
      throw new ForbiddenException({
        code: 'CONNECT_SELF_INQUIRY_NOT_ALLOWED',
        message: 'You cannot send an inquiry to your own listing.',
      });
    }

    // Dedupe check (optimistic). Concurrent creates race against the unique
    // index below; we catch the E11000 and return the existing row.
    const existing = await this.inquiryModel
      .findOne({ listingId: listingObjectId, buyerUserId: buyerObjectId })
      .exec();
    if (existing) {
      // Self-heal: ensure the inbox thread exists for a prior inquiry too.
      await this.seedInboxThread(buyerUserId, sellerUserId, String(existing._id), existing.message);
      return existing;
    }

    // Seller-side lead cap. `-1` from the allowance = unlimited, so `canUseLead`
    // short-circuits true and we never count the docs.
    const cycleStart = startOfCurrentCycle();
    const usedThisCycle = await this.inquiryModel.countDocuments({
      sellerUserId: listing.ownerUserId,
      createdAt: { $gte: cycleStart },
    });
    const canUse = await this.allowances.canUseLead(sellerUserId, usedThisCycle);
    if (!canUse) {
      throw new ForbiddenException({
        code: 'CONNECT_SELLER_LEAD_CAP_REACHED',
        message:
          'This seller has reached their inquiry limit for the month. Try again next month or look at other listings.',
      });
    }

    try {
      const inquiry = (await this.inquiryModel.create({
        listingId: listingObjectId,
        buyerUserId: buyerObjectId,
        sellerUserId: listing.ownerUserId,
        message: input.message ?? '',
        status: 'sent',
      })) as InquiryDocument;

      await this.audit.logEvent({
        module: AppModule.CONNECT,
        entityType: 'Inquiry',
        entityId: String(inquiry._id),
        action: 'inquiry_created',
        actorId: buyerUserId,
        meta: { listingId, sellerUserId },
      });
      this.posthog?.capture({
        distinctId: buyerUserId,
        event: 'connect.inquiry_created',
        properties: {
          listingId,
          sellerUserId,
          inquiryId: String(inquiry._id),
        },
      });

      // Seed the inbox thread FIRST so the bell notification can deep-link to the
      // conversation. Both are best-effort + never block the inquiry write.
      const threadId = await this.seedInboxThread(
        buyerUserId,
        sellerUserId,
        String(inquiry._id),
        inquiry.message,
      );

      const buyer = await this.userModel
        .findById(buyerObjectId)
        .select('name')
        .lean<{ name?: string }>()
        .exec();
      const buyerName = buyer?.name?.trim() || 'Someone';
      void this.notifications
        ?.dispatch({
          recipientId: listing.ownerUserId,
          actorId: buyerObjectId,
          category: 'connect.inquiry_received',
          entityType: 'Inquiry',
          entityId: String(inquiry._id),
          title: 'New inquiry',
          message: `${buyerName} is interested in "${listing.title}".`,
          // FE routing: open the conversation straight from the bell.
          metadata: threadId ? { threadId } : undefined,
        })
        .catch(() => undefined);

      return inquiry;
    } catch (err) {
      // E11000: the unique compound index fired between the dedupe check and
      // the create -- another concurrent request from the same buyer to the
      // same listing landed first. Re-fetch and return the winner so the
      // buyer experience stays idempotent.
      if (this.isDuplicateKeyError(err)) {
        const winner = await this.inquiryModel
          .findOne({ listingId: listingObjectId, buyerUserId: buyerObjectId })
          .exec();
        if (winner) return winner;
      }
      Sentry.captureException(err, { tags: { module: 'connect.inquiry', op: 'create' } });
      throw err;
    }
  }

  /**
   * One page of inquiries the caller has SENT (their buyer outbox), newest
   * first, hydrated with the listing summary + the SELLER (the other party).
   * Keyset-paginated (default 20, max 50) so a prolific buyer's outbox is never
   * returned unbounded.
   */
  async listMineSent(
    buyerUserId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<InquiryListPage> {
    return this.pageInquiries({ buyerUserId: new Types.ObjectId(buyerUserId) }, 'seller', opts);
  }

  /**
   * One page of inquiries the caller has RECEIVED on their listings (their seller
   * inbox), newest first, hydrated with the listing summary + the BUYER. Keyset-
   * paginated (default 20, max 50) — a popular seller's inbox grows without bound.
   */
  async listMineReceived(
    sellerUserId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<InquiryListPage> {
    return this.pageInquiries({ sellerUserId: new Types.ObjectId(sellerUserId) }, 'buyer', opts);
  }

  /**
   * Shared keyset paging for the inbox/outbox: over-fetch one row past `limit`
   * (createdAt desc, `_id` desc tiebreak — see common/keyset-cursor), shape the
   * page + nextCursor, then batch-hydrate ONLY the page's rows. The scope filter
   * (`buyerUserId` / `sellerUserId`) keeps each caller to their own inquiries.
   */
  private async pageInquiries(
    scope: FilterQuery<InquiryDocument>,
    partyKind: 'buyer' | 'seller',
    opts: { cursor?: string; limit?: number },
  ): Promise<InquiryListPage> {
    const limit = clampPageSize(opts.limit);
    const cursor = decodeCursor(opts.cursor);
    const window = await this.inquiryModel
      .find({ ...scope, ...keysetFilter(cursor) })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean<Array<LeanInquiry & KeysetRow>>()
      .exec();
    const { items: rows, nextCursor } = buildPage(window, limit);
    return { items: await this.hydrate(rows, partyKind), nextCursor };
  }

  /**
   * Batch-hydrate inquiry rows with their listing summary + the other party's
   * public identity. Two `$in` lookups total (listings + users), never N+1.
   * `partyKind` picks the "other party": the seller for a buyer's outbox, the
   * buyer for a seller's inbox. A deleted listing / user resolves to `null`.
   */
  private async hydrate(
    inquiries: LeanInquiry[],
    partyKind: 'buyer' | 'seller',
  ): Promise<InquiryListItem[]> {
    if (inquiries.length === 0) return [];

    const listingIds = [...new Set(inquiries.map((i) => String(i.listingId)))].map(
      (id) => new Types.ObjectId(id),
    );
    const partyIds = [
      ...new Set(
        inquiries.map((i) => String(partyKind === 'seller' ? i.sellerUserId : i.buyerUserId)),
      ),
    ].map((id) => new Types.ObjectId(id));

    const [listings, users] = await Promise.all([
      this.listingModel
        .find({ _id: { $in: listingIds } })
        .select('title images status')
        .lean<LeanListingSummary[]>()
        .exec(),
      this.userModel
        .find({ _id: { $in: partyIds } })
        .select('name profilePicture handle')
        .lean<LeanUserSummary[]>()
        .exec(),
    ]);

    const listingMap = new Map<string, InquiryListingSummary>(
      listings.map((l) => [
        String(l._id),
        {
          listingId: String(l._id),
          title: l.title,
          coverImage: l.images?.[0] ?? null,
          status: l.status,
        },
      ]),
    );
    const userMap = new Map<string, InquiryParty>(
      users.map((u) => [
        String(u._id),
        {
          userId: String(u._id),
          name: u.name,
          avatar: u.profilePicture ?? null,
          handle: u.handle ?? null,
        },
      ]),
    );

    // Resolve each inquiry's inbox thread id so a row deep-links straight to the
    // conversation. Best-effort: a missing inbox (or thread) leaves threadId null.
    const threadByInquiry =
      (await this.inbox?.getThreadIdsForContext(
        'Inquiry',
        inquiries.map((i) => String(i._id)),
      )) ?? new Map<string, string>();

    return inquiries.map((i) => {
      const partyId = String(partyKind === 'seller' ? i.sellerUserId : i.buyerUserId);
      return {
        _id: String(i._id),
        listingId: String(i.listingId),
        buyerUserId: String(i.buyerUserId),
        sellerUserId: String(i.sellerUserId),
        message: i.message,
        status: i.status,
        createdAt: i.createdAt ? i.createdAt.toISOString() : '',
        updatedAt: i.updatedAt ? i.updatedAt.toISOString() : '',
        listing: listingMap.get(String(i.listingId)) ?? null,
        party: userMap.get(partyId) ?? null,
        threadId: threadByInquiry.get(String(i._id)) ?? null,
      };
    });
  }

  /** Mongo / Mongoose duplicate-key check that holds across both error shapes. */
  private isDuplicateKeyError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const code = (err as { code?: number }).code;
    return code === DUPLICATE_KEY_ERROR;
  }
}
