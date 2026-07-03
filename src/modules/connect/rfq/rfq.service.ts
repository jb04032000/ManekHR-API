import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FilterQuery, Model, Types } from 'mongoose';
import { LIST_HARD_CAP } from '../common/keyset-cursor';
import { CONNECT_RFQ_CHANGED, type ConnectRfqChangedEvent } from './events/connect-rfq.events';
import { Rfq, type RfqDocument } from './schemas/rfq.schema';
import { Quote, type QuoteDocument } from './schemas/quote.schema';
import { Listing } from '../marketplace/schemas/listing.schema';
import { User } from '../../users/schemas/user.schema';
import {
  buildRfqBoardFilter,
  buildRfqBoardSort,
  statusBucketClause,
  type RfqBoardQuery,
} from './rfq-board-query.helpers';
import { AuditService } from '../../audit/audit.service';
import { AppModule } from '../../../common/enums/modules.enum';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { TagService } from '../tags/tag.service';
import { MediaOwnershipService } from '../../uploads/services/media-ownership.service';
import type {
  CreateRfqDto,
  CreateQuoteDto,
  RfqBoardQueryDto,
  RfqBoardFacetsQueryDto,
} from './dto/rfq.dto';

/** One countable value in a facet (e.g. district "Varachha" with 7 open RFQs). */
export interface RfqFacetEntry {
  value: string;
  count: number;
}

/**
 * Counts payload for the RFQ board filter rail (GET board/facets). Mirrors the
 * jobs JobBoardFacets pattern: `total` = count under ALL active filters; each
 * facet's counts are computed with that facet's OWN field removed (so they
 * answer "how many if I also picked this"). `status` buckets share the exact
 * clause the list filter uses (statusBucketClause -- no drift). The viewer-
 * scoped counts (matchedToMyWork / notQuotedByMe) feed the "Show me" rail
 * section. Web mirror: features/connect/rfq/rfq.types.ts BoardFacets.
 */
export interface RfqBoardFacets {
  total: number;
  category: RfqFacetEntry[];
  district: RfqFacetEntry[];
  status: { open: number; closingSoon: number; awarded: number };
  /** Count if "Matched to my work" were on (0 when the viewer supplies nothing). */
  matchedToMyWork: number;
  /** Count if "No quote from me yet" were on. */
  notQuotedByMe: number;
}

/** Raw $sortByCount bucket ({_id, count}) before mapping to RfqFacetEntry. */
interface RawBucket {
  _id: string | null;
  count: number;
}

/**
 * Headline numbers for the board KPI strip. Every number is real (counted, not
 * inferred). `supplyCategories` (the viewer's active listing categories) also
 * drives the web "Matches your work" ribbon + the rail toggle visibility.
 */
export interface RfqBoardStats {
  openTotal: number;
  newToday: number;
  matchesMyWork: number;
  supplyCategories: string[];
  myOpenRequests: number;
  quotesOnMyOpen: number;
  myQuotesTotal: number;
  myQuotesShortlisted: number;
  myQuotesWon: number;
}

/** A seller's own quote enriched with a small RFQ snapshot for the "My quotes"
 *  tab (one batch fetch, no per-row lookup). Web mirror: rfq.types MyQuoteView. */
export interface MyQuoteView extends Quote {
  rfq: {
    id: string;
    title: string;
    category: string;
    status: string;
    quotesCount: number;
    lowestQuotePrice: number | null;
    neededBy: Date | null;
    location: { district?: string; city?: string; state?: string } | null;
  } | null;
}

/** Quote statuses that count as "live" for lowestQuotePrice + quoted-rfq sets. */
const LIVE_QUOTE_STATUSES = ['sent', 'shortlisted', 'accepted'] as const;

/**
 * ManekHR Connect Marketplace -- RFQ + Quote (Phase 4, W4; board redesigned
 * 2026-06-10 to the Jobs-board bar). Board-only: a buyer posts an RFQ, sellers
 * browse the open board and submit a structured Quote, the buyer compares
 * (shortlist / decline / accept) and closes the deal off-platform (mediator
 * model). No chat, no seller notifications (owner-locked 2026-05-30).
 * Person-centric. Reads the marketplace Listing model (read-only) to derive the
 * viewer's supply categories for the "Matched to my work" scope.
 */
@Injectable()
export class RfqService {
  constructor(
    @InjectModel(Rfq.name) private readonly rfqModel: Model<RfqDocument>,
    @InjectModel(Quote.name) private readonly quoteModel: Model<QuoteDocument>,
    // Read-only: the viewer's ACTIVE listing categories = what they supply.
    @InjectModel(Listing.name) private readonly listingModel: Model<Listing>,
    // Read-only: the author's `isDemo` is read at create to stamp the
    // denormalized Rfq.isDemo / Quote.isDemo (demo/sample disclosure + down-rank).
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly audit: AuditService,
    // Folds a custom RFQ category into the shared ConnectTag pool (same engine
    // as a listing's / job's category) so it self-registers, dedupes, and
    // becomes searchable/suggestable. See createRfq.
    private readonly tagService: TagService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
    // Shared media-ownership guard (validates quote sample URLs belong to the
    // caller). @Optional so positional unit-test constructors keep working.
    @Optional() private readonly media: MediaOwnershipService,
    // Fires CONNECT_RFQ_CHANGED on close/award so BoostService.stopForRfq can
    // stop the RFQ's boost campaign (CN-BOOST-1). @Optional() so positional
    // unit-test constructors keep working; Nest DI always provides it.
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  /** Fire-and-forget CONNECT_RFQ_CHANGED (mirrors the listing/job emit). Kept
   *  thin (id + change) — the listener re-reads current RFQ state. */
  private emitRfqChanged(rfqId: string, change: ConnectRfqChangedEvent['change']): void {
    this.eventEmitter?.emit(CONNECT_RFQ_CHANGED, { rfqId, change });
  }

  // ── Buyer: RFQs ────────────────────────────────────────────────────

  /**
   * Read an author's `User.isDemo` so we can stamp the denormalized `isDemo`
   * flag on the content doc AT CREATE (mirrors Post.authorErpLinked). Missing /
   * absent user -> treated as NOT demo (real content default). One round trip,
   * `_id`-projected. Watch: keep this the single read source so the badge and
   * the down-rank stay consistent.
   */
  private async isDemoAuthor(userId: string): Promise<boolean> {
    const u = await this.userModel
      .findById(userId)
      .select('isDemo')
      .lean<{ isDemo?: boolean }>()
      .exec();
    return u?.isDemo === true;
  }

  async createRfq(buyerUserId: string, dto: CreateRfqDto): Promise<RfqDocument> {
    // Resolve the category through the shared tag engine so a custom term
    // self-registers into the ConnectTag pool and stays canonical (the composer
    // suggests from this pool via /connect/tags/search). Fall back to
    // trim+lowercase if the engine returns nothing. recordUsage is best-effort
    // (popularity ranking). Mirrors JobsService.createJob / ListingService.create.
    const [categorySlug] = await this.tagService.normalizeHashtags([dto.category]);
    const category = categorySlug ?? dto.category.trim().toLowerCase();

    // Stamp the demo/sample flag from the buyer's User.isDemo at create.
    const isDemo = await this.isDemoAuthor(buyerUserId);

    const rfq = await this.rfqModel.create({
      buyerUserId: new Types.ObjectId(buyerUserId),
      title: dto.title,
      description: dto.description ?? '',
      category,
      quantity: dto.quantity ?? null,
      unit: dto.unit,
      budgetMin: dto.budgetMin ?? null,
      budgetMax: dto.budgetMax ?? null,
      neededBy: dto.neededBy ? new Date(dto.neededBy) : null,
      location: dto.location ?? {},
      status: 'open',
      quotesCount: 0,
      lowestQuotePrice: null,
      isDemo,
    });
    // Record popularity for the resolved canonical slug (best-effort; creates
    // the open tag on first use so a brand-new custom category is suggestable).
    if (categorySlug) void this.tagService.recordUsage([categorySlug], buyerUserId);

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Rfq',
      entityId: String(rfq._id),
      action: 'rfq_created',
      actorId: buyerUserId,
      meta: { category },
    });
    this.posthog?.capture({
      distinctId: buyerUserId,
      event: 'connect.rfq_created',
      properties: { rfqId: String(rfq._id), category },
    });
    return rfq;
  }

  /** The viewer's supply categories: distinct categories of their ACTIVE listings. */
  private async supplyCategories(viewerId: string): Promise<string[]> {
    const cats = await this.listingModel
      .distinct('category', { ownerUserId: new Types.ObjectId(viewerId), status: 'active' })
      .exec();
    return cats.filter(Boolean);
  }

  /** RFQ ids the viewer has a non-withdrawn quote on (withdrawn = may re-quote). */
  private async quotedRfqIds(viewerId: string): Promise<Types.ObjectId[]> {
    const ids = await this.quoteModel
      .distinct('rfqId', {
        sellerUserId: new Types.ObjectId(viewerId),
        status: { $ne: 'withdrawn' },
      })
      .exec();
    return ids;
  }

  /**
   * Fold the viewer-scoped flags into a built board filter. `matchedToMyWork`
   * narrows category to the supply set (intersected with an explicit category
   * chip); `notQuotedByMe` excludes the viewer's quoted RFQ ids. '__none__' is
   * an impossible category so an empty supply set matches nothing (count 0)
   * rather than everything.
   */
  private applyViewerScope(
    filter: Record<string, unknown>,
    query: { matchedToMyWork?: boolean; notQuotedByMe?: boolean; category?: string },
    supplyCats: string[],
    quotedIds: Types.ObjectId[],
  ): Record<string, unknown> {
    const out = { ...filter };
    if (query.matchedToMyWork) {
      const cats = query.category ? supplyCats.filter((c) => c === query.category) : supplyCats;
      out.category = { $in: cats.length ? cats : ['__none__'] };
    }
    if (query.notQuotedByMe) {
      out._id = { $nin: quotedIds };
    }
    return out;
  }

  /**
   * The members board. Supports the redesigned filter rail (status buckets /
   * category / districts / budget+negotiable / posted / viewer scopes), sort,
   * text search and paging. A bare call returns open RFQs newest-first.
   */
  async listBoard(viewerId: string, query: RfqBoardQueryDto = {}): Promise<Rfq[]> {
    const base = buildRfqBoardFilter(query as RfqBoardQuery, new Date());
    const [supplyCats, quotedIds] = await Promise.all([
      query.matchedToMyWork ? this.supplyCategories(viewerId) : Promise.resolve([]),
      query.notQuotedByMe ? this.quotedRfqIds(viewerId) : Promise.resolve([]),
    ]);
    const filter = this.applyViewerScope(base, query, supplyCats, quotedIds) as FilterQuery<Rfq>;
    const limit = query.limit ?? 50;
    const skip = query.skip ?? 0;
    return this.rfqModel
      .find(filter)
      .sort(buildRfqBoardSort(query.sort))
      .skip(skip)
      .limit(limit)
      .lean<Rfq[]>()
      .exec();
  }

  /**
   * Facet counts for the rail. One `$facet` aggregation built from the SAME
   * filter builder the list uses, each branch with that facet's own field
   * removed (jobs boardFacets pattern). The status buckets reuse
   * statusBucketClause so the checklist counts equal the filtered results.
   */
  async boardFacets(viewerId: string, query: RfqBoardFacetsQueryDto): Promise<RfqBoardFacets> {
    const now = new Date();
    // Viewer-scope inputs are fetched when ANY branch needs them: the dedicated
    // "Show me" counts always do, so fetch both up front (cheap distinct reads).
    const [supplyCats, quotedIds] = await Promise.all([
      this.supplyCategories(viewerId),
      this.quotedRfqIds(viewerId),
    ]);

    // Build the filter with some fields omitted, viewer scopes applied per the
    // remaining flags. Both the facet's plural + singular forms are dropped.
    const build = (...omit: (keyof RfqBoardFacetsQueryDto)[]): Record<string, unknown> => {
      const q = { ...query };
      for (const f of omit) delete (q as Record<string, unknown>)[f as string];
      return this.applyViewerScope(
        buildRfqBoardFilter(q as RfqBoardQuery, now),
        q,
        supplyCats,
        quotedIds,
      );
    };
    const countStage = (path: string) => [{ $sortByCount: `$${path}` }, { $limit: 50 }];

    // Status buckets need the status DIMENSION removed from the base filter,
    // not just the `statuses` param: the bare builder defaults to status:'open',
    // which would AND-contradict the awarded bucket (count always 0). Setting
    // includeClosed widens the base to all statuses; each bucket clause then
    // narrows it back to its own derived definition.
    const statusBase = (() => {
      const q = { ...query, includeClosed: true } as RfqBoardFacetsQueryDto & {
        includeClosed: boolean;
      };
      delete (q as unknown as Record<string, unknown>).statuses;
      return this.applyViewerScope(
        buildRfqBoardFilter(q as RfqBoardQuery, now),
        q,
        supplyCats,
        quotedIds,
      );
    })();

    const [res] = await this.rfqModel.aggregate([
      {
        $facet: {
          total: [{ $match: build() }, { $count: 'n' }],
          // Category chips: own field + matchedToMyWork removed (both narrow category).
          category: [{ $match: build('category', 'matchedToMyWork') }, ...countStage('category')],
          district: [
            { $match: build('districts', 'district') },
            ...countStage('location.district'),
          ],
          // Status buckets: the status-free base ANDed with the SAME derived
          // clause the list filter applies (statusBucketClause - no drift).
          statusOpen: [
            { $match: { $and: [statusBase, statusBucketClause('open', now)] } },
            { $count: 'n' },
          ],
          statusClosingSoon: [
            { $match: { $and: [statusBase, statusBucketClause('closing-soon', now)] } },
            { $count: 'n' },
          ],
          statusAwarded: [
            { $match: { $and: [statusBase, statusBucketClause('awarded', now)] } },
            { $count: 'n' },
          ],
          // "Show me" counts: the filter minus that toggle, plus the toggle's clause.
          matchedToMyWork: [
            {
              $match: {
                $and: [
                  build('matchedToMyWork'),
                  { category: { $in: supplyCats.length ? supplyCats : ['__none__'] } },
                ],
              },
            },
            { $count: 'n' },
          ],
          notQuotedByMe: [
            { $match: { $and: [build('notQuotedByMe'), { _id: { $nin: quotedIds } }] } },
            { $count: 'n' },
          ],
        },
      },
    ]);

    const n = (buckets?: Array<{ n?: number }>) => buckets?.[0]?.n ?? 0;
    const map = (buckets: RawBucket[] = []): RfqFacetEntry[] =>
      buckets
        .filter((b) => b._id != null && b._id !== '')
        .map((b) => ({ value: String(b._id), count: b.count }));

    // "Selected always visible": union-in any selected district missing from the
    // top-50 buckets at count 0 (case-insensitive; district is free-text vocab).
    const district = map(res?.district);
    const selectedDistricts = (query.districts ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const present = new Set(district.map((e) => e.value.toLowerCase()));
    for (const sel of selectedDistricts) {
      if (!present.has(sel.toLowerCase())) {
        district.push({ value: sel, count: 0 });
        present.add(sel.toLowerCase());
      }
    }

    return {
      total: n(res?.total),
      category: map(res?.category),
      district,
      status: {
        open: n(res?.statusOpen),
        closingSoon: n(res?.statusClosingSoon),
        awarded: n(res?.statusAwarded),
      },
      matchedToMyWork: n(res?.matchedToMyWork),
      notQuotedByMe: n(res?.notQuotedByMe),
    };
  }

  /** Headline counts for the board KPI strip (real numbers, never faked). */
  async boardStats(viewerId: string): Promise<RfqBoardStats> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const viewer = new Types.ObjectId(viewerId);
    const supplyCats = await this.supplyCategories(viewerId);

    const [
      openTotal,
      newToday,
      matchesMyWork,
      myOpenRequests,
      quotesOnMyOpenAgg,
      myQuotesTotal,
      myQuotesShortlisted,
      myQuotesWon,
    ] = await Promise.all([
      this.rfqModel.countDocuments({ status: 'open' }),
      this.rfqModel.countDocuments({ status: 'open', createdAt: { $gte: startOfToday } }),
      supplyCats.length
        ? this.rfqModel.countDocuments({ status: 'open', category: { $in: supplyCats } })
        : Promise.resolve(0),
      this.rfqModel.countDocuments({ buyerUserId: viewer, status: 'open' }),
      this.rfqModel.aggregate<{ total: number }>([
        { $match: { buyerUserId: viewer, status: 'open' } },
        { $group: { _id: null, total: { $sum: '$quotesCount' } } },
        { $project: { _id: 0, total: 1 } },
      ]),
      this.quoteModel.countDocuments({ sellerUserId: viewer }),
      this.quoteModel.countDocuments({ sellerUserId: viewer, status: 'shortlisted' }),
      this.quoteModel.countDocuments({ sellerUserId: viewer, status: 'accepted' }),
    ]);

    return {
      openTotal,
      newToday,
      matchesMyWork,
      supplyCategories: supplyCats,
      myOpenRequests,
      quotesOnMyOpen: quotesOnMyOpenAgg[0]?.total ?? 0,
      myQuotesTotal,
      myQuotesShortlisted,
      myQuotesWon,
    };
  }

  /** A buyer's own RFQs, newest first. */
  async listMine(buyerUserId: string): Promise<Rfq[]> {
    return this.rfqModel
      .find({ buyerUserId: new Types.ObjectId(buyerUserId) })
      .sort({ createdAt: -1 })
      .lean<Rfq[]>()
      .exec();
  }

  /**
   * A single RFQ (the detail / quote surface), enriched with two ADDITIVE
   * context blocks the detail page renders (existing consumers that read only
   * the Rfq fields are unaffected):
   * - `buyerStats`: the buyer's real track record on this board (requests
   *   posted / awarded). Counted from this module's own collections -- no
   *   fabricated "avg reply" style signals.
   * - `quoteStats`: anonymized spread of LIVE quote totals (count/low/high) so
   *   a seller can position their price. Never exposes who quoted what; the
   *   per-quote list stays buyer-only (listQuotesForMyRfq).
   */
  async getRfq(rfqId: string): Promise<
    Rfq & {
      buyerStats: { rfqsPosted: number; rfqsAwarded: number };
      quoteStats: { count: number; low: number | null; high: number | null };
    }
  > {
    const rfq = await this.rfqModel.findById(rfqId).lean<Rfq>().exec();
    if (!rfq) throw new NotFoundException('Request not found');
    const [rfqsPosted, rfqsAwarded, spread] = await Promise.all([
      this.rfqModel.countDocuments({ buyerUserId: rfq.buyerUserId }),
      this.rfqModel.countDocuments({ buyerUserId: rfq.buyerUserId, status: 'awarded' }),
      this.quoteModel.aggregate<{ count: number; low: number; high: number }>([
        // Exclude demo quotes so a real RFQ's anonymized price spread stays real
        // (same exclusion as recomputeLowestQuote + the quotesCount increment).
        {
          $match: {
            rfqId: rfq._id,
            status: { $in: [...LIVE_QUOTE_STATUSES] },
            isDemo: { $ne: true },
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            low: { $min: '$price' },
            high: { $max: '$price' },
          },
        },
      ]),
    ]);
    // Object.assign keeps the lean doc's Rfq typing (a spread would drop the
    // Document side of the intersection and fail the return type).
    return Object.assign(rfq, {
      buyerStats: { rfqsPosted, rfqsAwarded },
      quoteStats: {
        count: spread[0]?.count ?? 0,
        low: spread[0]?.low ?? null,
        high: spread[0]?.high ?? null,
      },
    });
  }

  async closeRfq(buyerUserId: string, rfqId: string): Promise<RfqDocument> {
    const rfq = await this.loadOwnedRfq(buyerUserId, rfqId);
    rfq.status = 'closed';
    await rfq.save();
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Rfq',
      entityId: rfqId,
      action: 'rfq_closed',
      actorId: buyerUserId,
    });
    // CN-BOOST-1: a closed RFQ can no longer serve — stop any boost campaign.
    this.emitRfqChanged(rfqId, 'closed');
    return rfq;
  }

  // ── Seller: Quotes ─────────────────────────────────────────────────

  /** Submit (or update) a quote on an open RFQ. One quote per seller per RFQ. */
  async createQuote(
    sellerUserId: string,
    rfqId: string,
    dto: CreateQuoteDto,
  ): Promise<QuoteDocument> {
    const rfq = await this.rfqModel.findById(rfqId);
    if (!rfq) throw new NotFoundException('Request not found');
    if (rfq.status !== 'open') throw new BadRequestException('This request is no longer open');
    if (String(rfq.buyerUserId) === sellerUserId) {
      throw new BadRequestException('You cannot quote your own request');
    }

    // Demo/real interaction gate: keep seeded demo/sample content in its own
    // sandbox. A demo seller may NOT quote a real buyer's RFQ, and a real seller
    // may NOT quote a demo RFQ -- otherwise demo content would pollute (or be
    // polluted by) real deals + aggregates. Demo<->demo and real<->real are fine.
    // Mirror the same surfaced "no longer open" tone so we never leak that the
    // counterparty is a sample account.
    const sellerIsDemo = await this.isDemoAuthor(sellerUserId);
    if (sellerIsDemo !== (rfq.isDemo === true)) {
      throw new BadRequestException('This request is no longer open');
    }

    const existing = await this.quoteModel.findOne({
      rfqId: rfq._id,
      sellerUserId: new Types.ObjectId(sellerUserId),
    });

    // Validate every submitted sample URL is a real file on our storage AND was
    // uploaded by this seller (calls the shared media-ownership guard). On an
    // update, the existing quote's already-stored sample URLs are grandfathered
    // (they predate ownership tracking / were accepted before).
    await this.media.assertOwnedMedia(dto.sampleUrls ?? [], sellerUserId, {
      grandfatheredUrls: existing?.sampleUrls ?? [],
    });

    let quote: QuoteDocument;
    if (existing) {
      existing.price = dto.price;
      existing.rate = dto.rate ?? null;
      existing.rateQuantity = dto.rateQuantity ?? null;
      existing.includes = dto.includes ?? [];
      existing.validityDays = dto.validityDays ?? null;
      existing.sampleUrls = dto.sampleUrls ?? [];
      existing.leadTimeDays = dto.leadTimeDays ?? null;
      existing.message = dto.message ?? '';
      if (dto.storefrontId) existing.storefrontId = new Types.ObjectId(dto.storefrontId);
      existing.status = 'sent';
      quote = await existing.save();
    } else {
      quote = await this.quoteModel.create({
        rfqId: rfq._id,
        sellerUserId: new Types.ObjectId(sellerUserId),
        storefrontId: dto.storefrontId ? new Types.ObjectId(dto.storefrontId) : null,
        price: dto.price,
        rate: dto.rate ?? null,
        rateQuantity: dto.rateQuantity ?? null,
        includes: dto.includes ?? [],
        validityDays: dto.validityDays ?? null,
        sampleUrls: dto.sampleUrls ?? [],
        leadTimeDays: dto.leadTimeDays ?? null,
        message: dto.message ?? '',
        status: 'sent',
        // Stamp from the seller's User.isDemo (== rfq.isDemo here, per the gate
        // above). A demo quote stays out of a real RFQ's quotesCount: only a
        // non-demo quote increments the visible count.
        isDemo: sellerIsDemo,
      });
      if (!sellerIsDemo) {
        await this.rfqModel.updateOne({ _id: rfq._id }, { $inc: { quotesCount: 1 } });
      }
    }
    // Keep the board's "low ₹X" honest after every price change (demo quotes are
    // excluded from the aggregate inside recomputeLowestQuote).
    await this.recomputeLowestQuote(rfq._id);

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Quote',
      entityId: String(quote._id),
      action: existing ? 'quote_updated' : 'quote_created',
      actorId: sellerUserId,
    });
    this.posthog?.capture({
      distinctId: sellerUserId,
      event: 'connect.quote_created',
      properties: { quoteId: String(quote._id), rfqId },
    });
    return quote;
  }

  /** The buyer's view of all quotes on their RFQ (owner-only). */
  async listQuotesForMyRfq(buyerUserId: string, rfqId: string): Promise<Quote[]> {
    await this.loadOwnedRfq(buyerUserId, rfqId);
    return (
      this.quoteModel
        .find({ rfqId: new Types.ObjectId(rfqId) })
        .sort({ createdAt: -1 })
        // DoS backstop: quotes grow with other sellers' submissions. Far above any
        // realistic quote count (the FE price-comparison bar reads the full set);
        // an RFQ that hits this should graduate to keyset paging.
        .limit(LIST_HARD_CAP)
        .lean<Quote[]>()
        .exec()
    );
  }

  /**
   * A seller's own quotes enriched with a small RFQ snapshot (one batch fetch)
   * so the "My quotes" tab can show what each quote was FOR without per-row
   * lookups. Mirrors the jobs listMyApplications enrichment pattern.
   */
  async listMyQuotes(sellerUserId: string): Promise<MyQuoteView[]> {
    const quotes = await this.quoteModel
      .find({ sellerUserId: new Types.ObjectId(sellerUserId) })
      .sort({ createdAt: -1 })
      .lean<Quote[]>()
      .exec();
    const rfqIds = [...new Set(quotes.map((q) => String(q.rfqId)))];
    const rfqs = rfqIds.length
      ? await this.rfqModel
          .find({ _id: { $in: rfqIds.map((id) => new Types.ObjectId(id)) } })
          .select('title category status quotesCount lowestQuotePrice neededBy location')
          .lean<Rfq[]>()
          .exec()
      : [];
    const byId = new Map(rfqs.map((r) => [String(r._id), r]));
    return quotes.map((q) => {
      const r = byId.get(String(q.rfqId));
      return {
        ...q,
        rfq: r
          ? {
              id: String(r._id),
              title: r.title,
              category: r.category,
              status: r.status,
              quotesCount: r.quotesCount,
              lowestQuotePrice: r.lowestQuotePrice ?? null,
              neededBy: r.neededBy ?? null,
              location: r.location ?? null,
            }
          : null,
      } as MyQuoteView;
    });
  }

  /** Buyer accepts a quote -> it is marked accepted and the RFQ is awarded. */
  async acceptQuote(buyerUserId: string, quoteId: string): Promise<QuoteDocument> {
    const quote = await this.quoteModel.findById(quoteId);
    if (!quote) throw new NotFoundException('Quote not found');
    await this.loadOwnedRfq(buyerUserId, String(quote.rfqId));

    quote.status = 'accepted';
    await quote.save();
    await this.rfqModel.updateOne({ _id: quote.rfqId }, { $set: { status: 'awarded' } });

    // CN-BOOST-1: an awarded RFQ has left `open` and can no longer serve — stop
    // any boost campaign (same servability signal as close).
    this.emitRfqChanged(String(quote.rfqId), 'closed');

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Quote',
      entityId: quoteId,
      action: 'quote_accepted',
      actorId: buyerUserId,
    });
    this.posthog?.capture({
      distinctId: buyerUserId,
      event: 'connect.quote_accepted',
      properties: { quoteId, rfqId: String(quote.rfqId) },
    });
    return quote;
  }

  /**
   * Buyer shortlists a live quote (finalist while comparing). Open RFQs only;
   * the quote must be live (sent). Feeds the seller's "shortlisted" stat.
   */
  async shortlistQuote(buyerUserId: string, quoteId: string): Promise<QuoteDocument> {
    const quote = await this.quoteModel.findById(quoteId);
    if (!quote) throw new NotFoundException('Quote not found');
    const rfq = await this.loadOwnedRfq(buyerUserId, String(quote.rfqId));
    if (rfq.status !== 'open') throw new BadRequestException('This request is no longer open');
    if (quote.status !== 'sent') {
      throw new BadRequestException('Only an active quote can be shortlisted');
    }
    quote.status = 'shortlisted';
    await quote.save();
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Quote',
      entityId: quoteId,
      action: 'quote_shortlisted',
      actorId: buyerUserId,
    });
    this.posthog?.capture({
      distinctId: buyerUserId,
      event: 'connect.quote_shortlisted',
      properties: { quoteId, rfqId: String(quote.rfqId) },
    });
    return quote;
  }

  /** Buyer declines a live quote (sent or shortlisted). */
  async declineQuote(buyerUserId: string, quoteId: string): Promise<QuoteDocument> {
    const quote = await this.quoteModel.findById(quoteId);
    if (!quote) throw new NotFoundException('Quote not found');
    await this.loadOwnedRfq(buyerUserId, String(quote.rfqId));
    if (quote.status !== 'sent' && quote.status !== 'shortlisted') {
      throw new BadRequestException('Only an active quote can be declined');
    }
    quote.status = 'declined';
    await quote.save();
    await this.recomputeLowestQuote(quote.rfqId);
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Quote',
      entityId: quoteId,
      action: 'quote_declined',
      actorId: buyerUserId,
    });
    return quote;
  }

  /** Seller withdraws their own quote. */
  async withdrawQuote(sellerUserId: string, quoteId: string): Promise<QuoteDocument> {
    const quote = await this.quoteModel.findById(quoteId);
    if (!quote || String(quote.sellerUserId) !== sellerUserId) {
      throw new NotFoundException('Quote not found');
    }
    const wasLive = (LIVE_QUOTE_STATUSES as readonly string[]).includes(quote.status);
    quote.status = 'withdrawn';
    await quote.save();
    // Decrement the RFQ's received-quote count when a LIVE quote is withdrawn
    // (createQuote does +1). Guarded so it never goes below 0. Demo quotes never
    // incremented the count, so they must not decrement it (stay symmetric).
    if (wasLive && quote.isDemo !== true) {
      await this.rfqModel.updateOne(
        { _id: quote.rfqId, quotesCount: { $gt: 0 } },
        { $inc: { quotesCount: -1 } },
      );
    }
    await this.recomputeLowestQuote(quote.rfqId);
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Quote',
      entityId: quoteId,
      action: 'quote_withdrawn',
      actorId: sellerUserId,
    });
    return quote;
  }

  /** Recompute the RFQ's denormalized lowest LIVE quote price ("low ₹X").
   *  Takes the already-typed rfq ObjectId straight off the document (no recast).
   *  Demo-involved quotes are excluded ({ isDemo: { $ne: true } }) so a seeded
   *  sample quote never feeds a real RFQ's "low ₹X" (the gate keeps demo quotes
   *  on demo RFQs, but the filter is defensive + matches quoteStats in getRfq). */
  private async recomputeLowestQuote(rfqId: Types.ObjectId): Promise<void> {
    const [agg] = await this.quoteModel.aggregate<{ low: number }>([
      { $match: { rfqId, status: { $in: [...LIVE_QUOTE_STATUSES] }, isDemo: { $ne: true } } },
      { $group: { _id: null, low: { $min: '$price' } } },
    ]);
    await this.rfqModel.updateOne({ _id: rfqId }, { $set: { lowestQuotePrice: agg?.low ?? null } });
  }

  private async loadOwnedRfq(buyerUserId: string, rfqId: string): Promise<RfqDocument> {
    const rfq = await this.rfqModel.findById(rfqId);
    if (!rfq || String(rfq.buyerUserId) !== buyerUserId) {
      throw new NotFoundException('Request not found');
    }
    return rfq;
  }
}
