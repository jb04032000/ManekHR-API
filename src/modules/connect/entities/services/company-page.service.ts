import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types, type FilterQuery } from 'mongoose';
import { CompanyPage, type CompanyPageDocument } from '../schemas/company-page.schema';
import { Workspace } from '../../../workspaces/schemas/workspace.schema';
// User backs the owner-derived `isDemo` on the public page (the "Sample"
// disclosure badge + parity with the shared feed/search down-rank).
import { User } from '../../../users/schemas/user.schema';
import { isWorkspaceOwner } from '../../../../common/utils/workspace-ownership.util';
import { ERP_VERIFY_CONSENT_VERSION } from '../../profile/erp-verification.constants';
import {
  CONNECT_COMPANY_PAGE_CHANGED,
  type ConnectCompanyPageChangedEvent,
} from '../events/connect-company-page.events';
import { generateUniqueEntitySlug } from '../entity-slug.util';
import { pickBrowseSort, toFacets, type BrowseFacet } from '../company-page-browse.helpers';
import type { CompanyPageKind } from '../schemas/company-page.schema';
import { normalizePlace } from '../company-page-location.helpers';
import { ConnectAllowanceService } from '../../monetization/connect-allowance.service';
import { ConnectOverLimitService } from '../../over-limit/connect-over-limit.service';
import { ErpLinkService } from '../../profile/erp-link.service';
import { ReviewService, type RatingAggregate } from '../../reviews/review.service';
import { AuditService } from '../../../audit/audit.service';
import { AppModule } from '../../../../common/enums/modules.enum';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { MediaOwnershipService } from '../../../uploads/services/media-ownership.service';
// CN-LIM-3: serialize the company-page cap check+insert per owner (see
// connect-cap-lock.util). Reuses the shared Redis mutex, not a new primitive.
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { connectCapLockKey } from '../../over-limit/connect-cap-lock.util';
import type { CreateCompanyPageDto, UpdateCompanyPageDto } from '../dto/company-page.dto';

/** The privacy-trimmed ERP-linked signal shown on a public entity page. */
export interface PublicErpLink {
  linked: boolean;
  since: Date | null;
}

export interface PublicCompanyPage {
  page: CompanyPage;
  erpLink: PublicErpLink;
  /** The owner's seller rating aggregate (R2). Present only when rated. */
  rating?: RatingAggregate;
  /** Whether the page's owner is a seeded demo/sample account (User.isDemo).
   *  Drives the FE "Sample" disclosure badge on the public page; reads the same
   *  signal as the directory card + the shared feed/search down-rank. */
  isDemo: boolean;
}

/** Minimal page identity for batch hydration (feed page-post author block). */
export interface CompanyPageRef {
  id: string;
  name: string;
  slug: string;
  logo: string;
  /**
   * Whether the page is ERP-linked (derived `!!erpWorkspaceId`, same rule as the
   * browse card / getPublicBySlug badge). Feeds the jobs board ERP-verified badge
   * (batch); keep in sync with web JobEmployerRef.
   */
  erpLinked: boolean;
}

/** Filter / pagination params for the public directory browse. */
export interface BrowseCompanyPagesParams {
  q?: string;
  district?: string;
  specialization?: string;
  /** Keep only pages of this kind (`institute` powers the Institutes tab). */
  kind?: CompanyPageKind;
  /** Keep only ERP-linked pages (the real trust filter). */
  erpVerified?: boolean;
  /** Keep only pages whose owner's seller rating is at least this (e.g. 4 / 4.5). */
  minRating?: number;
  /** Result order: `recent` (default) or `name`. */
  sort?: 'recent' | 'name';
  page?: number;
  pageSize?: number;
}

/** One directory card's worth of public company-page data. */
export interface CompanyPageBrowseItem {
  id: string;
  /**
   * The page owner's public Connect userId. Used by the public controller to key
   * the author-level seller rating, and carried through to the card so the
   * directory can start a direct message with the owner (the same id used by
   * public profiles / DMs).
   */
  ownerUserId: string;
  slug: string;
  name: string;
  logo: string;
  /** The page banner (cover) URL, '' when none — the directory card shows it
   *  when present and falls back to a decorative gradient otherwise. */
  banner: string;
  /** A short plain-text snippet of `about` (truncated server-side). */
  about: string;
  /** Whether the page is a business (default) or a training institute -- the
   *  directory card badges institutes and the Institutes tab filters on it. */
  kind: CompanyPageKind;
  location: { district: string; city: string; state: string };
  specialization: string[];
  /** Whether the page is ERP-linked (the derived trust signal, no workspace leak). */
  erpLinked: boolean;
  /**
   * Whether the page has an intro video (derived `videos?.length > 0`). A
   * lightweight card flag - the directory paints a play badge but never needs the
   * full video objects, so they stay off the card (mirrors the listing-card
   * `hasVideo` precedent in the marketplace toListingRef).
   */
  hasVideo: boolean;
  /** Members following the page. Filled by the public controller (cross-collection). */
  followerCount: number;
  /** This page's open job posts. Filled by the public controller. */
  openJobsCount: number;
  /** Active products across the page's storefronts. Filled by the public controller. */
  productCount: number;
  /** The owner's seller rating. Set by the public controller ONLY when rated. */
  rating?: { ratingAvg: number; ratingCount: number };
  /** Whether the page's owner is a seeded demo/sample account (User.isDemo).
   *  Set by the public controller (cross-collection lookup); drives the FE
   *  "Sample" disclosure badge + matches the shared feed/search down-rank. */
  isDemo: boolean;
}

/** A page of directory results. */
export interface CompanyPageBrowseResult {
  items: CompanyPageBrowseItem[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** Facet values present across the filtered set, with real counts (the strip +
   *  the rail). Each facet ignores its OWN active selection so its siblings stay
   *  switchable (specialization ignores `?specialization=`, district ignores
   *  `?district=`); both honour the other filters (q / erpVerified / the sibling). */
  facets: { specialization: BrowseFacet[]; district: BrowseFacet[]; kind: BrowseFacet[] };
}

const BROWSE_DEFAULT_PAGE_SIZE = 24;
const BROWSE_MAX_PAGE_SIZE = 48;
const BROWSE_ABOUT_SNIPPET = 240;

/** Escape user input before using it in a RegExp (a directory filter must never
 *  let a stray `.` or `*` widen the query or throw). */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A trimmed, single-line snippet of `about` for a directory card. Collapses
 *  whitespace and adds an ellipsis when truncated. */
function snippet(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`;
}

/**
 * Whether an entity (CompanyPage / Storefront) earns the ERP-verified card flag
 * under the consent gate (ADR-0004 / 2026-06-18 spec): the owner linked it
 * through the ownership-checked path (`erpLink.status === 'verified'`) AND a
 * workspace pointer is present. A dangling `erpWorkspaceId` with no verified
 * link, or a revoked link, never shows the badge. Shared by the directory card
 * derivations + refs so every entity surface honours the gate identically. The
 * Mongo filter equivalent is `ERP_VERIFIED_FILTER` below.
 */
export function isEntityErpVerified(entity: {
  erpWorkspaceId?: Types.ObjectId | string | null;
  erpLink?: { status?: string } | null;
}): boolean {
  return entity.erpLink?.status === 'verified' && !!entity.erpWorkspaceId;
}

/**
 * The Mongo `$match` fragment for "ERP-verified" entities — the consent-gated
 * counterpart of `isEntityErpVerified`, used by the directory `erpVerified`
 * filter + the `erpVerified` sort. Requires BOTH a verified link status and a
 * non-null workspace pointer.
 */
const ERP_VERIFIED_FILTER = {
  'erpLink.status': 'verified',
  erpWorkspaceId: { $ne: null },
} as const;

/**
 * ManekHR Connect -- Company Page CRUD (Phase 6, on the W1 entity foundation).
 *
 * Person-centric: every page is owned by one `User` (`ownerUserId`); reads +
 * writes authorize by userId only (mirrors `ListingService.loadOwned`), never a
 * workspace. Create is gated by the per-person Company Page cap
 * (`ConnectAllowanceService.assertCanCreateCompanyPage`). The slug is derived
 * server-side + made unique. The public read derives the ERP-linked badge from
 * `erpWorkspaceId` via `ErpLinkService` (never stored) and returns only
 * `{ linked, since }` (privacy wall, same trim as `/u/[slug]`).
 */
@Injectable()
export class CompanyPageService {
  private readonly logger = new Logger(CompanyPageService.name);

  constructor(
    @InjectModel(CompanyPage.name)
    private readonly model: Model<CompanyPageDocument>,
    private readonly allowances: ConnectAllowanceService,
    private readonly erpLink: ErpLinkService,
    private readonly audit: AuditService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
    /**
     * Folds the owner's seller rating aggregate into the public page (R2).
     * Optional so the service still constructs in isolation (unit tests).
     */
    @Optional() private readonly reviews?: ReviewService,
    /**
     * Enforces logo/banner are files the caller actually uploaded (IDOR guard).
     * @Optional + last so positional unit-test constructors keep working; DI
     * supplies it in production (see MediaOwnershipModule in entities.module).
     */
    @Optional() private readonly media?: MediaOwnershipService,
    /**
     * Over-limit suppression (grandfathering). Hides an owner's newest-beyond-
     * limit company pages from public reads under the hide_newest policy; the
     * owner still sees them. @Optional + LAST so positional unit-test constructors
     * keep working; a no-op under the default freeze policy.
     */
    @Optional() private readonly overLimit?: ConnectOverLimitService,
    /**
     * Emits `connect.companyPage.changed` so the search indexer keeps the
     * `connect_pages` Meili index warm (SRCH-VERT-1). @Optional + LAST so
     * positional unit-test constructors keep working; production DI supplies the
     * @Global EventEmitter2. When absent the emit is skipped (a unit-test no-op).
     */
    @Optional() private readonly events?: EventEmitter2,
    /**
     * The ERP `Workspace` collection — read ONLY to verify the caller owns a
     * workspace before linking it to this page (ADR-0004 / 2026-06-18 spec,
     * `linkErpWorkspace`). @Optional + LAST so positional unit-test constructors
     * keep working; the link path asserts it is wired. Registered for read access
     * in `entities.module.ts`.
     */
    @Optional()
    @InjectModel(Workspace.name)
    private readonly workspaceModel?: Model<Workspace>,
    /**
     * The `User` collection — read ONLY to derive the owner's `isDemo` for the
     * public page's "Sample" disclosure badge. @Optional + LAST so positional
     * unit-test constructors keep working; when absent the page reads as real.
     * Registered for read access in `entities.module.ts`.
     */
    @Optional()
    @InjectModel(User.name)
    private readonly userModel?: Model<User>,
    /**
     * CN-LIM-3: shared Redis mutex to serialize the company-page cap check+insert
     * per owner (closes the two-parallel-creates-at-limit-1 race). @Optional + LAST
     * so positional unit-test constructors keep working; runs inline when absent.
     * Provided globally by SchedulerModule (@Global).
     */
    @Optional() private readonly capLock?: SingleFlightService,
  ) {}

  /**
   * Fire the index-freshness signal for one company / institute page
   * (SRCH-VERT-1). Thin + fire-and-forget: the listener re-reads the page's live
   * visibility + kind, so a create / edit / visibility-flip / delete all funnel
   * through the same emit and the index converges on the latest state. No-op when
   * the emitter is absent.
   */
  private emitCompanyPageChanged(companyPageId: string): void {
    const payload: ConnectCompanyPageChangedEvent = { companyPageId };
    this.events?.emit(CONNECT_COMPANY_PAGE_CHANGED, payload);
  }

  /**
   * CN-LIM-3: run `fn` under the per-owner company-page-cap mutex. Inline (no
   * lock) when the SingleFlightService isn't injected (positional unit-test
   * constructors).
   */
  private async withCapLock<T>(ownerUserId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.capLock) return fn();
    return this.capLock.withLock(connectCapLockKey('company_page', ownerUserId), fn);
  }

  async create(ownerUserId: string, dto: CreateCompanyPageDto): Promise<CompanyPageDocument> {
    // Logo/banner must be files this user uploaded (IDOR guard), before persist.
    await this.media.assertOwnedMedia([dto.logo, dto.banner], ownerUserId);

    // Intro video gets its OWN ownership check + server-derived durationSec stamp
    // (see buildOwnedVideos). Empty input -> [] so a pre-video page is unchanged.
    const videos = await this.buildOwnedVideos(dto.videos, ownerUserId);

    const slug = await generateUniqueEntitySlug(
      dto.name,
      (s) => this.model.exists({ slug: s }).then((r) => r !== null),
      'company',
    );

    // CN-LIM-3 critical section: (re-)count the owner's company pages, assert the
    // cap, and insert under the per-owner mutex so two parallel creates at limit-1
    // can't both pass and land at limit+1 (the second re-counts and is rejected).
    const doc = await this.withCapLock(ownerUserId, async () => {
      const count = await this.model.countDocuments({
        ownerUserId: new Types.ObjectId(ownerUserId),
      });
      await this.allowances.assertCanCreateCompanyPage(ownerUserId, count);

      return this.model.create({
        ownerUserId: new Types.ObjectId(ownerUserId),
        slug,
        name: dto.name,
        about: dto.about ?? '',
        logo: dto.logo ?? '',
        banner: dto.banner ?? '',
        videos,
        kind: dto.kind ?? 'business',
        industryPanel: dto.industryPanel ?? {},
        institutePanel: dto.institutePanel ?? {},
        location: await this.normalizeLocationInput(dto.location ?? {}),
        // ERP link is NOT set on create (ADR-0004): it requires a separate
        // ownership-checked `linkErpWorkspace` call. A new page starts unlinked.
        erpWorkspaceId: null,
        erpLink: null,
        visibility: dto.visibility ?? 'public',
      });
    });

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'CompanyPage',
      entityId: String(doc._id),
      action: 'company_page_created',
      actorId: ownerUserId,
    });
    this.posthog?.capture({
      distinctId: ownerUserId,
      event: 'connect.company_page_created',
      properties: { companyPageId: String(doc._id), slug },
    });
    // Index the new page (a `public` page becomes searchable by name).
    this.emitCompanyPageChanged(String(doc._id));
    return doc;
  }

  /** The owner's own company pages, newest first. */
  async listMine(ownerUserId: string): Promise<CompanyPage[]> {
    return this.model
      .find({ ownerUserId: new Types.ObjectId(ownerUserId) })
      .sort({ createdAt: -1 })
      .lean<CompanyPage[]>()
      .exec();
  }

  /** Load a page the caller owns, or 404 (no existence leak for non-owners). */
  async getMine(ownerUserId: string, id: string): Promise<CompanyPageDocument> {
    return this.loadOwned(ownerUserId, id);
  }

  async update(
    ownerUserId: string,
    id: string,
    dto: UpdateCompanyPageDto,
  ): Promise<CompanyPageDocument> {
    const doc = await this.loadOwned(ownerUserId, id);
    // Validate any new logo/banner; grandfather the page's existing urls (they
    // predate ownership tracking). Undefined patch fields are skipped by the guard.
    await this.media.assertOwnedMedia([dto.logo, dto.banner], ownerUserId, {
      grandfatheredUrls: [doc.logo, doc.banner],
    });
    if (dto.name !== undefined) doc.name = dto.name;
    if (dto.about !== undefined) doc.about = dto.about;
    if (dto.logo !== undefined) doc.logo = dto.logo;
    if (dto.banner !== undefined) doc.banner = dto.banner;
    // Intro video: only when the patch carries `videos` (omit = unchanged). The
    // existing clip is grandfathered (its url/poster predate this edit) and the
    // durationSec is re-derived server-side. Mirrors ListingService.update.
    if (dto.videos !== undefined) {
      doc.videos = await this.buildOwnedVideos(dto.videos, ownerUserId, doc.videos);
    }
    if (dto.kind !== undefined) doc.kind = dto.kind;
    if (dto.industryPanel !== undefined) {
      doc.industryPanel = { ...doc.industryPanel, ...dto.industryPanel };
    }
    if (dto.institutePanel !== undefined) {
      doc.institutePanel = { ...doc.institutePanel, ...dto.institutePanel };
    }
    if (dto.location !== undefined) {
      doc.location = await this.normalizeLocationInput({ ...doc.location, ...dto.location });
    }
    // ERP link is intentionally NOT mutated here (ADR-0004): it is owned by the
    // ownership-checked link / unlink path, not the generic page update.
    if (dto.visibility !== undefined) doc.visibility = dto.visibility;
    await doc.save();

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'CompanyPage',
      entityId: id,
      action: 'company_page_updated',
      actorId: ownerUserId,
    });
    // Re-index on edit: a name/about/kind/specialization/course edit refreshes
    // the index doc; a visibility flip away from `public` de-indexes (the
    // listener re-reads the live visibility and removes a now-hidden page).
    this.emitCompanyPageChanged(id);
    return doc;
  }

  async remove(ownerUserId: string, id: string): Promise<void> {
    const doc = await this.loadOwned(ownerUserId, id);
    await doc.deleteOne();
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'CompanyPage',
      entityId: id,
      action: 'company_page_deleted',
      actorId: ownerUserId,
    });
    // De-index the deleted page: the listener re-reads, finds it missing, and
    // removes the index doc so a deleted page never surfaces in search.
    this.emitCompanyPageChanged(id);
  }

  // ── Ownership-checked ERP linking (ADR-0004 / 2026-06-18 spec) ──────────────

  /**
   * Link this page to an ERP workspace — the consent + ownership-verified path
   * that REPLACES the old raw `erpWorkspaceId` DTO acceptance. The caller must
   * own BOTH the page (`loadOwned`, 404 otherwise) AND the workspace
   * (`isWorkspaceOwner`, `ForbiddenException` otherwise) — closing the prior gap
   * where a crafted request could inherit another workspace's trust. Records the
   * `erpLink` consent sub-doc (status `verified`, who/when/version) + sets
   * `erpWorkspaceId`. Audited. Idempotent re-link refreshes the record.
   *
   * Cross-module: reads the `Workspace` collection (WorkspacesModule) for the
   * ownership check; the badge derivation (`getConsentedWorkspaceStatus`) gates
   * on the `erpLink.status` written here.
   */
  async linkErpWorkspace(
    ownerUserId: string,
    pageId: string,
    workspaceId: string,
  ): Promise<CompanyPageDocument> {
    const doc = await this.loadOwned(ownerUserId, pageId);
    await this.assertOwnsWorkspace(ownerUserId, workspaceId);

    doc.erpWorkspaceId = new Types.ObjectId(workspaceId);
    doc.erpLink = {
      status: 'verified',
      linkedByUserId: new Types.ObjectId(ownerUserId),
      linkedAt: new Date(),
      consentVersion: ERP_VERIFY_CONSENT_VERSION,
    };
    await doc.save();

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'CompanyPage',
      entityId: pageId,
      action: 'company_page_erp_linked',
      actorId: ownerUserId,
      meta: { workspaceId },
    });
    this.posthog?.capture({
      distinctId: ownerUserId,
      event: 'connect.company_page_erp_linked',
      properties: { companyPageId: pageId, workspaceId },
    });
    return doc;
  }

  /**
   * Unlink this page from its ERP workspace (owner action). Sets the consent
   * record to `revoked` and clears `erpWorkspaceId` so the badge drops
   * immediately. Tolerates an already-unlinked page (no-op write). Audited.
   * The same clear shape is applied by the deletion cascades (workspace delete,
   * account erasure) with `actor=system`.
   */
  async unlinkErpWorkspace(ownerUserId: string, pageId: string): Promise<CompanyPageDocument> {
    const doc = await this.loadOwned(ownerUserId, pageId);
    doc.erpWorkspaceId = null;
    doc.erpLink = doc.erpLink ? { ...doc.erpLink, status: 'revoked', linkedAt: null } : null;
    await doc.save();

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'CompanyPage',
      entityId: pageId,
      action: 'company_page_erp_unlinked',
      actorId: ownerUserId,
    });
    this.posthog?.capture({
      distinctId: ownerUserId,
      event: 'connect.company_page_erp_unlinked',
      properties: { companyPageId: pageId },
    });
    return doc;
  }

  /**
   * Verify the caller owns the workspace they are linking. Loads the workspace
   * and applies the shared `isWorkspaceOwner` check; throws `ForbiddenException`
   * for a non-owner / missing workspace (no existence leak beyond "not yours").
   */
  private async assertOwnsWorkspace(ownerUserId: string, workspaceId: string): Promise<void> {
    if (!this.workspaceModel) {
      // Mis-wired DI would be a bug; fail closed rather than silently link.
      throw new ForbiddenException('You must own that workspace to link it');
    }
    const workspace = Types.ObjectId.isValid(workspaceId)
      ? await this.workspaceModel
          .findById(workspaceId)
          .select('ownerId')
          .lean<{ ownerId?: Types.ObjectId }>()
          .exec()
      : null;
    if (!isWorkspaceOwner(workspace, ownerUserId)) {
      throw new ForbiddenException('You must own that workspace to link it');
    }
  }

  /**
   * Public read by slug. `hidden` pages 404 to anyone but the owner. `public`
   * and `connections` are returned (the network-restricted `connections` view
   * is a later refinement; a company page is public-facing business info).
   * Derives the ERP-linked badge from `erpWorkspaceId`, trimmed to
   * `{ linked, since }`.
   */
  async getPublicBySlug(slug: string, viewerUserId?: string): Promise<PublicCompanyPage> {
    const page = await this.model
      .findOne({ slug })
      .lean<CompanyPage & { _id: Types.ObjectId; ownerUserId: Types.ObjectId }>()
      .exec();
    return this.toPublic(page, viewerUserId);
  }

  /**
   * Batch-resolve minimal page identity for a list of ids - the feed hydrates a
   * page post's author block from this (mirrors the `connect/people` batch).
   * Hidden pages are dropped (their identity is not public). Unknown ids are
   * silently omitted; order is not guaranteed (the caller maps by id).
   */
  async getRefs(ids: string[]): Promise<CompanyPageRef[]> {
    const objectIds = ids
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (objectIds.length === 0) return [];
    // Project `erpWorkspaceId` + `erpLink` so we can carry the ERP-verified flag
    // on the ref (jobs board badge). Consent-gated (ADR-0004): the badge shows
    // only when the link is verified AND a workspace pointer is present — never
    // the raw id, never a dangling pointer.
    const pages = await this.model
      .find({ _id: { $in: objectIds }, visibility: { $ne: 'hidden' } })
      .select('name slug logo erpWorkspaceId erpLink')
      .lean<
        Array<{
          _id: Types.ObjectId;
          name: string;
          slug: string;
          logo?: string;
          erpWorkspaceId?: Types.ObjectId | null;
          erpLink?: { status?: string } | null;
        }>
      >()
      .exec();
    return pages.map((p) => ({
      id: String(p._id),
      name: p.name,
      slug: p.slug,
      logo: p.logo ?? '',
      erpLinked: isEntityErpVerified(p),
    }));
  }

  /**
   * Lightweight company-name type-ahead for the profile experience picker. Public
   * pages only, case-insensitive name match, capped. Returns the same minimal
   * CompanyPageRef shape as getRefs. Cross-module: web profile experience editor
   * calls this via GET connect/company-pages/public/search.
   */
  async searchByName(q: string, limit = 8): Promise<CompanyPageRef[]> {
    const term = (q ?? '').trim();
    if (term.length < 2) return [];
    const rx = new RegExp(escapeRegExp(term), 'i');
    const rows = await this.model
      .find({ name: rx, visibility: 'public' })
      .select('name slug logo erpWorkspaceId erpLink')
      .limit(Math.min(Math.max(limit, 1), 10))
      .lean<
        Array<{
          _id: Types.ObjectId;
          name: string;
          slug: string;
          logo?: string;
          erpWorkspaceId?: Types.ObjectId | null;
          erpLink?: { status?: string } | null;
        }>
      >()
      .exec();
    // Same ref shape getRefs returns (id/name/slug/logo + consent-gated erpLinked).
    return rows.map((p) => ({
      id: String(p._id),
      name: p.name,
      slug: p.slug,
      logo: p.logo ?? '',
      erpLinked: isEntityErpVerified(p),
    }));
  }

  /**
   * Whether a page is publicly visible by id. Used by the public attached-store
   * endpoint so a `hidden`/`connections` page never leaks its store identity to a
   * logged-out caller hitting `.../public/:pageId/store` directly. Links to:
   * company-page-public.controller getPublicAttachedStore.
   */
  async isPublicById(pageId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(pageId)) return false;
    const page = await this.model
      .findOne({ _id: new Types.ObjectId(pageId), visibility: 'public' })
      .select('_id')
      .lean<{ _id: Types.ObjectId } | null>()
      .exec();
    return !!page;
  }

  /**
   * Distinct district / city values across `public` pages - backs the directory
   * location search and the create/edit autocomplete. Optional case-insensitive
   * `q` match; sorted by frequency then name; capped (1..20).
   */
  async distinctLocations(
    field: 'district' | 'city',
    q: string | undefined,
    limit: number,
  ): Promise<Array<{ value: string; count: number }>> {
    const path = `location.${field}`;
    const cap = Math.min(20, Math.max(1, Math.floor(limit || 10)));
    const term = q?.trim();
    const match: FilterQuery<CompanyPageDocument> = {
      visibility: 'public',
      [path]: term
        ? { $nin: [null, ''], $regex: new RegExp(escapeRegExp(term), 'i') }
        : { $nin: [null, ''] },
    };
    const rows = await this.model.aggregate<{ _id: string; count: number }>([
      { $match: match },
      { $group: { _id: `$${path}`, count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: cap },
    ]);
    return rows.map((r) => ({ value: r._id, count: r.count }));
  }

  /**
   * Public directory browse: paginated, newest-first list of `public` company
   * pages, with optional free-text (name / specialization), district, and exact
   * specialization-tag filters. `hidden` and `connections` pages are excluded
   * (a directory is a public-discovery surface). Returns only the lightweight
   * card fields (no per-row ERP/follower derivation, so it stays a single query)
   * plus a total + `hasMore` for pagination.
   */
  async browse(params: BrowseCompanyPagesParams): Promise<CompanyPageBrowseResult> {
    const page = Math.max(1, Math.floor(params.page ?? 1));
    const pageSize = Math.min(
      BROWSE_MAX_PAGE_SIZE,
      Math.max(1, Math.floor(params.pageSize ?? BROWSE_DEFAULT_PAGE_SIZE)),
    );

    // `commonFilter` = the always-on parts (visibility + free-text + ERP-verified).
    // District / specialization are layered per query so each facet can ignore its
    // OWN active selection (keeping its siblings clickable) while honouring the rest.
    const commonFilter: FilterQuery<CompanyPageDocument> = { visibility: 'public' };
    const q = params.q?.trim();
    if (q) {
      const rx = new RegExp(escapeRegExp(q), 'i');
      commonFilter.$or = [{ name: rx }, { 'industryPanel.specialization': rx }];
    }
    if (params.erpVerified) {
      // Consent-gated trust filter (ADR-0004): only pages whose owner linked
      // them through the verified path, not any page with a (possibly dangling)
      // `erpWorkspaceId`. Shared with `isEntityErpVerified` (the card derivation).
      Object.assign(commonFilter, ERP_VERIFIED_FILTER);
    }
    // Minimum owner rating: resolve the rated owners that clear the bar (from the
    // denormalized SellerRating aggregate) and constrain by ownerUserId so the
    // count / facets / page all honour it and pagination stays correct. No rated
    // owner clears it -> an empty `$in` yields no results (the honest answer).
    if (params.minRating && params.minRating > 0 && this.reviews) {
      const owners = await this.reviews.ownersWithMinRating(params.minRating);
      commonFilter.ownerUserId = {
        $in: owners.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id)),
      };
    }

    const district = params.district?.trim();
    const specialization = params.specialization?.trim();
    const districtCond = district
      ? { 'location.district': new RegExp(escapeRegExp(district), 'i') }
      : null;
    const specCond = specialization ? { 'industryPanel.specialization': specialization } : null;
    // Page-kind filter (the Institutes tab). Layered like district / specialization
    // so the kind facet can ignore its OWN active selection (keeping its siblings
    // switchable) while honouring the rest. Legacy docs predate `kind`, so an
    // absent value reads as a business: a `kind=business` filter matches both an
    // explicit 'business' and a missing field, so no document is stranded.
    const kindCond = params.kind
      ? params.kind === 'business'
        ? { kind: { $in: ['business', null] as Array<string | null> } }
        : { kind: params.kind }
      : null;

    const listFilter: FilterQuery<CompanyPageDocument> = {
      ...commonFilter,
      ...(districtCond ?? {}),
      ...(specCond ?? {}),
      ...(kindCond ?? {}),
    };
    // Specialization facet keeps the active district + kind, drops the active specialization.
    const specFacetFilter: FilterQuery<CompanyPageDocument> = {
      ...commonFilter,
      ...(districtCond ?? {}),
      ...(kindCond ?? {}),
    };
    // District facet keeps the active specialization + kind, drops the active district, and
    // only counts pages that actually carry a district.
    const districtFacetFilter: FilterQuery<CompanyPageDocument> = {
      ...commonFilter,
      ...(specCond ?? {}),
      ...(kindCond ?? {}),
      'location.district': { $nin: [null, ''] },
    };
    // Kind facet keeps the active district + specialization, drops the active kind,
    // so the Business / Institutes counts stay switchable. A missing `kind` rolls
    // into the `business` bucket (see the $ifNull in the pipeline below).
    const kindFacetFilter: FilterQuery<CompanyPageDocument> = {
      ...commonFilter,
      ...(districtCond ?? {}),
      ...(specCond ?? {}),
    };

    const [docs, total, specRows, districtRows, kindRows] = await Promise.all([
      this.model
        .find(listFilter)
        .sort(pickBrowseSort(params.sort))
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .select(
          // `videos` projected only so the card can derive the lightweight `hasVideo`
          // flag; the full objects are dropped in the map below (never on the card).
          // `erpLink` projected so the card's `erpLinked` flag honours the consent gate.
          'ownerUserId name slug logo banner about location industryPanel.specialization kind erpWorkspaceId erpLink videos',
        )
        .lean<
          Array<{
            _id: Types.ObjectId;
            ownerUserId: Types.ObjectId;
            name: string;
            slug: string;
            logo?: string;
            banner?: string;
            about?: string;
            location?: { district?: string; city?: string; state?: string };
            industryPanel?: { specialization?: string[] };
            kind?: CompanyPageKind;
            erpWorkspaceId?: Types.ObjectId | null;
            erpLink?: { status?: string } | null;
            videos?: Array<{ url: string }>;
          }>
        >()
        .exec(),
      this.model.countDocuments(listFilter),
      this.model.aggregate<{ _id: string; count: number }>([
        { $match: specFacetFilter },
        { $unwind: '$industryPanel.specialization' },
        { $group: { _id: '$industryPanel.specialization', count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        { $limit: 12 },
      ]),
      this.model.aggregate<{ _id: string; count: number }>([
        { $match: districtFacetFilter },
        { $group: { _id: '$location.district', count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        // 20 (not 12) so the rail's "Show more" has a long tail to reveal.
        { $limit: 20 },
      ]),
      // Kind facet: Business / Institutes counts for the directory tabs. A legacy
      // page with no `kind` field rolls into the `business` bucket via $ifNull so
      // the counts always sum to the filtered total.
      this.model.aggregate<{ _id: string; count: number }>([
        { $match: kindFacetFilter },
        { $group: { _id: { $ifNull: ['$kind', 'business'] }, count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        { $limit: 2 },
      ]),
    ]);

    const items: CompanyPageBrowseItem[] = docs.map((d) => ({
      id: String(d._id),
      ownerUserId: String(d.ownerUserId),
      slug: d.slug,
      name: d.name,
      logo: d.logo ?? '',
      banner: d.banner ?? '',
      about: snippet(d.about ?? '', BROWSE_ABOUT_SNIPPET),
      // Legacy pages predate `kind`; an absent value reads as a business.
      kind: d.kind ?? 'business',
      location: {
        district: d.location?.district ?? '',
        city: d.location?.city ?? '',
        state: d.location?.state ?? '',
      },
      specialization: d.industryPanel?.specialization ?? [],
      // Consent-gated: ERP-verified only when the link is `verified` (ADR-0004).
      erpLinked: isEntityErpVerified(d),
      // Lightweight play-badge flag; the full video objects never reach the card.
      hasVideo: (d.videos?.length ?? 0) > 0,
      // Cross-collection counts are merged by the public controller (followers /
      // open jobs / storefront products / owner rating live in other modules);
      // default to 0 so the shape is complete before the merge.
      followerCount: 0,
      openJobsCount: 0,
      productCount: 0,
      // Owner-derived demo flag is stamped by the public controller's merge
      // (cross-collection User.isDemo lookup); default real before the merge.
      isDemo: false,
    }));

    return {
      items,
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
      facets: {
        specialization: toFacets(specRows),
        district: toFacets(districtRows),
        // Cap 2 (only two kinds); toFacets drops zero-count buckets.
        kind: toFacets(kindRows, 2),
      },
    };
  }

  /** Public read by id (the page-posts + follow surfaces resolve a page by id). */
  async getPublicById(id: string, viewerUserId?: string): Promise<PublicCompanyPage> {
    const page = Types.ObjectId.isValid(id)
      ? await this.model
          .findById(id)
          .lean<CompanyPage & { _id: Types.ObjectId; ownerUserId: Types.ObjectId }>()
          .exec()
      : null;
    return this.toPublic(page, viewerUserId);
  }

  /** Shared public-read assembly: hidden/unknown 404-gate + derived ERP badge. */
  private async toPublic(
    page: (CompanyPage & { _id: Types.ObjectId; ownerUserId: Types.ObjectId }) | null,
    viewerUserId?: string,
  ): Promise<PublicCompanyPage> {
    if (!page) {
      throw new NotFoundException('Company page not found');
    }
    const isOwner = !!viewerUserId && String(page.ownerUserId) === String(viewerUserId);
    if (page.visibility === 'hidden' && !isOwner) {
      throw new NotFoundException('Company page not found');
    }
    // Over-limit suppression (hide_newest): a suppressed company page reads as
    // not-found to the public; the owner always sees their own. No-op under freeze.
    if (this.overLimit && !isOwner) {
      const suppressed = await this.overLimit.getSuppressedIds(
        String(page.ownerUserId),
        'company_page',
      );
      if (suppressed.includes(String(page._id))) {
        throw new NotFoundException('Company page not found');
      }
    }

    // Consent-gated ERP badge (ADR-0004 / 2026-06-18): the derivation runs ONLY
    // when the page's own `erpLink.status === 'verified'` (the owner linked it
    // through the ownership-checked, consented path). A dangling `erpWorkspaceId`
    // left by a cascade race, or a revoked / never-consented link, yields no
    // badge. Public read reveals only `{ linked, since }` (the year on the web) —
    // never the worker headcount (privacy; that stays in the owner-only panel).
    let erpLink: PublicErpLink = { linked: false, since: null };
    try {
      const status = await this.erpLink.getConsentedWorkspaceStatus(page);
      erpLink = { linked: !!status?.linked, since: status?.since ?? null };
    } catch (e) {
      const err = e as { message?: string };
      this.logger.warn(
        `ERP-link derive failed for company page ${String(page._id)}: ${err.message}`,
      );
    }
    // Owner's seller rating aggregate (R2) - attached only when rated.
    const rating = await this.reviews?.getAggregate(String(page.ownerUserId));
    // Owner-derived demo flag for the "Sample" disclosure badge (reads the same
    // User.isDemo as the directory card + the shared feed/search down-rank). One
    // light projected read; absent model (unit tests) reads as real.
    const isDemo = await this.isOwnerDemo(page.ownerUserId);
    return {
      page,
      erpLink,
      isDemo,
      ...(rating && rating.ratingCount > 0 ? { rating } : {}),
    };
  }

  /**
   * Whether a page owner is a seeded demo/sample account (User.isDemo). One
   * projected read; returns false when the User model is absent (positional
   * unit-test constructors) or the user was hard-deleted. Mirrors the
   * denormalized `isDemo` precedent so the badge + down-rank read one source.
   */
  private async isOwnerDemo(ownerUserId: Types.ObjectId | string): Promise<boolean> {
    if (!this.userModel) return false;
    const owner = await this.userModel
      .findById(ownerUserId)
      .select('isDemo')
      .lean<{ isDemo?: boolean } | null>()
      .exec();
    return owner?.isDemo === true;
  }

  /**
   * Normalize a location's district + city before persisting: collapse
   * whitespace and snap each to an existing canonical spelling so free-text
   * entries do not fragment the directory facets. State is left untouched.
   */
  private async normalizeLocationInput<
    T extends { district?: string; city?: string; state?: string },
  >(loc: T): Promise<T> {
    const out = { ...loc };
    if (typeof loc.district === 'string') {
      out.district = await this.canonicalPlace('location.district', loc.district);
    }
    if (typeof loc.city === 'string') {
      out.city = await this.canonicalPlace('location.city', loc.city);
    }
    return out;
  }

  /**
   * Snap a place value to an existing public-page spelling (case-insensitive),
   * so "surat" entered after "Surat" reuses "Surat". Empty -> ''. A brand-new
   * place -> the normalized typed value (becomes canonical for the next writer).
   */
  private async canonicalPlace(
    field: 'location.district' | 'location.city',
    value: string,
  ): Promise<string> {
    const v = normalizePlace(value);
    if (!v) return '';
    try {
      const existing = await this.model
        .findOne({ visibility: 'public', [field]: new RegExp(`^${escapeRegExp(v)}$`, 'i') })
        .select('location')
        .lean<{ location?: { district?: string; city?: string } }>()
        .exec();
      const key = field === 'location.district' ? 'district' : 'city';
      const found = existing?.location?.[key];
      return typeof found === 'string' && found.trim() ? found : v;
    } catch {
      return v;
    }
  }

  /**
   * Build the stored video array from the submitted clips. COPIED verbatim in
   * shape from `ListingService.buildOwnedVideos` (the canonical pattern): every
   * clip `url` AND its optional `posterUrl` must be a file THIS user uploaded
   * (shared media-ownership guard), then each clip's `durationSec` is set from the
   * SERVER-parsed duration on the owned upload record - never a client claim.
   * Empty input -> empty result (clears the video on an explicit `videos: []`).
   *
   * `grandfatheredVideos` (update path) exempts a clip already on the page from
   * the ownership-RECORD check (its url/posterUrl were accepted before this edit);
   * format/host checks still apply to every url. The 60s length cap is enforced
   * upstream in the uploads media-probe (`connect-company-video` policy), not here.
   *
   * Links to: uploads MediaOwnershipService (assertOwnedMedia +
   * getServerVideoDurationByUrl) and the `connect-company-video` upload policy.
   */
  private async buildOwnedVideos(
    videos: Array<{ url: string; posterUrl?: string }> | undefined,
    ownerUserId: string,
    grandfatheredVideos?: Array<{ url: string; posterUrl?: string }>,
  ): Promise<Array<{ url: string; posterUrl?: string; durationSec?: number }>> {
    if (!videos || videos.length === 0) return [];
    // Flatten clip url + poster url for the batched ownership check (the guard
    // skips empty/undefined slots, so a posterless clip is fine).
    const grandfatheredUrls = (grandfatheredVideos ?? []).flatMap((v) => [v.url, v.posterUrl]);
    const submittedUrls = videos.flatMap((v) => [v.url, v.posterUrl]);
    await this.media.assertOwnedMedia(submittedUrls, ownerUserId, { grandfatheredUrls });
    return Promise.all(
      videos.map(async (v) => {
        const durationSec = await this.media.getServerVideoDurationByUrl(v.url, ownerUserId);
        return {
          url: v.url,
          ...(v.posterUrl ? { posterUrl: v.posterUrl } : {}),
          ...(durationSec != null ? { durationSec } : {}),
        };
      }),
    );
  }

  private async loadOwned(ownerUserId: string, id: string): Promise<CompanyPageDocument> {
    const doc = await this.model.findById(id);
    if (!doc || String(doc.ownerUserId) !== String(ownerUserId)) {
      throw new NotFoundException('Company page not found');
    }
    return doc;
  }
}
