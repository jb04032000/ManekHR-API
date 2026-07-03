import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FilterQuery, Model, Types } from 'mongoose';
import { Storefront, type StorefrontDocument } from '../schemas/storefront.schema';
import { Workspace } from '../../../workspaces/schemas/workspace.schema';
// User backs the owner-derived `isDemo` on the public storefront (the "Sample"
// disclosure badge + parity with the shared feed/search down-rank).
import { User } from '../../../users/schemas/user.schema';
import { isWorkspaceOwner } from '../../../../common/utils/workspace-ownership.util';
import { ERP_VERIFY_CONSENT_VERSION } from '../../profile/erp-verification.constants';
import {
  CONNECT_STOREFRONT_CHANGED,
  type ConnectStorefrontChangedEvent,
} from '../events/connect-storefront.events';
import { CompanyPage, type CompanyPageDocument } from '../schemas/company-page.schema';
import { generateUniqueEntitySlug } from '../entity-slug.util';
import { ConnectAllowanceService } from '../../monetization/connect-allowance.service';
import { ConnectOverLimitService } from '../../over-limit/connect-over-limit.service';
import { ErpLinkService } from '../../profile/erp-link.service';
import { AuditService } from '../../../audit/audit.service';
import { AppModule } from '../../../../common/enums/modules.enum';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { MediaOwnershipService } from '../../../uploads/services/media-ownership.service';
// CN-LIM-3: serialize the storefront cap check+insert per owner (see
// connect-cap-lock.util). Reuses the shared Redis mutex, not a new primitive.
import { SingleFlightService } from '../../../../common/scheduler/single-flight.service';
import { connectCapLockKey } from '../../over-limit/connect-cap-lock.util';
import type { CreateStorefrontDto, UpdateStorefrontDto } from '../dto/storefront.dto';
import type { PublicErpLink } from './company-page.service';

export interface PublicStorefront {
  storefront: Storefront;
  erpLink: PublicErpLink;
  /** Whether the storefront's owner is a seeded demo/sample account
   *  (User.isDemo). Drives the FE "Sample" disclosure badge; reads the same
   *  signal as the directory card + the shared feed/search down-rank. */
  isDemo: boolean;
}

/**
 * ManekHR Connect -- Storefront CRUD (Phase 4, on the W1 entity foundation).
 *
 * The seller's shop: the branded home for the products (marketplace Listings)
 * it sells. Mirrors CompanyPageService (person-centric, slug, allowance cap,
 * derived ERP badge), plus an OPTIONAL `companyPageId` link the caller must own
 * (set via the "Start selling" quick-setup). Products belong to a storefront
 * once `Listing.storefrontId` lands (W3 migration); the storefront's public
 * listings join is added then.
 */
@Injectable()
export class StorefrontService {
  private readonly logger = new Logger(StorefrontService.name);

  constructor(
    @InjectModel(Storefront.name)
    private readonly model: Model<StorefrontDocument>,
    @InjectModel(CompanyPage.name)
    private readonly companyPageModel: Model<CompanyPageDocument>,
    private readonly allowances: ConnectAllowanceService,
    private readonly erpLink: ErpLinkService,
    private readonly audit: AuditService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
    /**
     * Enforces logo/banner are files the caller actually uploaded (IDOR guard).
     * @Optional + last so positional unit-test constructors keep working; DI
     * supplies it in production (see MediaOwnershipModule in entities.module).
     */
    @Optional() private readonly media?: MediaOwnershipService,
    /**
     * Over-limit suppression (grandfathering). Hides an owner's newest-beyond-
     * limit storefronts from public reads under the hide_newest policy; the owner
     * still sees them. @Optional + LAST so positional unit-test constructors keep
     * working; a no-op under the default freeze policy.
     */
    @Optional() private readonly overLimit?: ConnectOverLimitService,
    /**
     * Emits `connect.storefront.changed` so the search indexer keeps the
     * `connect_storefronts` Meili index warm (SRCH-VERT-1). @Optional + LAST so
     * positional unit-test constructors keep working; production DI supplies the
     * @Global EventEmitter2. When absent the emit is skipped (a unit-test no-op).
     */
    @Optional() private readonly events?: EventEmitter2,
    /**
     * The ERP `Workspace` collection — read ONLY to verify the caller owns a
     * workspace before linking it to this storefront (ADR-0004, `linkErpWorkspace`).
     * @Optional + LAST so positional unit-test constructors keep working; the link
     * path asserts it is wired. Registered for read access in `entities.module.ts`.
     */
    @Optional()
    @InjectModel(Workspace.name)
    private readonly workspaceModel?: Model<Workspace>,
    /**
     * The `User` collection — read ONLY to derive the owner's `isDemo` for the
     * public storefront's "Sample" disclosure badge. @Optional + LAST so
     * positional unit-test constructors keep working; when absent the shop reads
     * as real. Registered for read access in `entities.module.ts`.
     */
    @Optional()
    @InjectModel(User.name)
    private readonly userModel?: Model<User>,
    /**
     * CN-LIM-3: shared Redis mutex to serialize the storefront cap check+insert
     * per owner (closes the two-parallel-creates-at-limit-1 race). @Optional + LAST
     * so positional unit-test constructors keep working; runs inline when absent.
     * Provided globally by SchedulerModule (@Global). NOTE: only the user-facing
     * `create` below is locked — `getOrCreateDefaultStorefront` is a system backfill
     * that intentionally bypasses the cap, so it must NOT take this lock.
     */
    @Optional() private readonly capLock?: SingleFlightService,
  ) {}

  /**
   * Fire the index-freshness signal for one storefront (SRCH-VERT-1). Thin +
   * fire-and-forget: the listener re-reads the shop's live visibility, so a
   * create / edit / visibility-flip / delete all funnel through the same emit and
   * the index converges on the latest state. No-op when the emitter is absent.
   */
  private emitStorefrontChanged(storefrontId: string): void {
    const payload: ConnectStorefrontChangedEvent = { storefrontId };
    this.events?.emit(CONNECT_STOREFRONT_CHANGED, payload);
  }

  /**
   * CN-LIM-3: run `fn` under the per-owner storefront-cap mutex. Inline (no lock)
   * when the SingleFlightService isn't injected (positional unit-test constructors).
   */
  private async withCapLock<T>(ownerUserId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.capLock) return fn();
    return this.capLock.withLock(connectCapLockKey('storefront', ownerUserId), fn);
  }

  async create(ownerUserId: string, dto: CreateStorefrontDto): Promise<StorefrontDocument> {
    if (dto.companyPageId) {
      await this.assertOwnsCompanyPage(ownerUserId, dto.companyPageId);
    }

    // Logo/banner must be files this user uploaded (IDOR guard), before persist.
    await this.media.assertOwnedMedia([dto.logo, dto.banner], ownerUserId);

    const slug = await generateUniqueEntitySlug(
      dto.name,
      (s) => this.model.exists({ slug: s }).then((r) => r !== null),
      'shop',
    );

    // CN-LIM-3 critical section: (re-)count the owner's storefronts, assert the
    // cap, and insert under the per-owner mutex so two parallel creates at limit-1
    // can't both pass and land at limit+1 (the second re-counts and is rejected).
    // Slug generation stays outside the lock (its own uniqueness collision is
    // handled independently by generateUniqueEntitySlug).
    const doc = await this.withCapLock(ownerUserId, async () => {
      const count = await this.model.countDocuments({
        ownerUserId: new Types.ObjectId(ownerUserId),
      });
      await this.allowances.assertCanCreateStorefront(ownerUserId, count);

      return this.model.create({
        ownerUserId: new Types.ObjectId(ownerUserId),
        slug,
        name: dto.name,
        description: dto.description ?? '',
        logo: dto.logo ?? '',
        banner: dto.banner ?? '',
        categories: dto.categories ?? [],
        location: dto.location ?? {},
        companyPageId: dto.companyPageId ? new Types.ObjectId(dto.companyPageId) : null,
        // ERP link is NOT set on create (ADR-0004): it requires a separate
        // ownership-checked `linkErpWorkspace` call. A new shop starts unlinked.
        erpWorkspaceId: null,
        erpLink: null,
        visibility: dto.visibility ?? 'public',
      });
    });

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Storefront',
      entityId: String(doc._id),
      action: 'storefront_created',
      actorId: ownerUserId,
    });
    this.posthog?.capture({
      distinctId: ownerUserId,
      event: 'connect.storefront_created',
      properties: { storefrontId: String(doc._id), slug, linkedCompanyPage: !!dto.companyPageId },
    });
    // Index the new shop (a `public` shop becomes searchable by name).
    this.emitStorefrontChanged(String(doc._id));
    return doc;
  }

  /**
   * Return the owner's default storefront (their oldest), creating one if they
   * have none. BYPASSES the storefront cap on purpose: this is a system
   * reconciliation (every product needs a shop home), not a user-initiated
   * create. Used by both ListingService.create (when no storefront is given)
   * and the W3 listing->storefront backfill migration. Idempotent per owner.
   */
  async getOrCreateDefaultStorefront(
    ownerUserId: string,
    name = 'My shop',
  ): Promise<StorefrontDocument> {
    const existing = await this.model
      .findOne({ ownerUserId: new Types.ObjectId(ownerUserId) })
      .sort({ createdAt: 1 })
      .exec();
    if (existing) return existing;

    const slug = await generateUniqueEntitySlug(
      name,
      (s) => this.model.exists({ slug: s }).then((r) => r !== null),
      'shop',
    );
    const doc = await this.model.create({
      ownerUserId: new Types.ObjectId(ownerUserId),
      slug,
      name,
      visibility: 'public',
    });
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Storefront',
      entityId: String(doc._id),
      action: 'storefront_created',
      actorId: ownerUserId,
      meta: { auto: true },
    });
    // Auto-created default shops are `public`, so they too join the index.
    this.emitStorefrontChanged(String(doc._id));
    return doc;
  }

  /** The owner's own storefronts, newest first. */
  async listMine(ownerUserId: string): Promise<Storefront[]> {
    return this.model
      .find({ ownerUserId: new Types.ObjectId(ownerUserId) })
      .sort({ createdAt: -1 })
      .lean<Storefront[]>()
      .exec();
  }

  async getMine(ownerUserId: string, id: string): Promise<StorefrontDocument> {
    return this.loadOwned(ownerUserId, id);
  }

  /**
   * Minimal public reference (name + slug) for a storefront by id, or null when
   * it does not exist. No ownership check: used to stamp the public listing
   * detail with its shop breadcrumb + "View storefront" link.
   */
  async getRefById(id: string): Promise<{ id: string; name: string; slug: string } | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await this.model
      .findById(id)
      .select('_id name slug')
      .lean<{ _id: Types.ObjectId; name: string; slug: string }>()
      .exec();
    return doc ? { id: String(doc._id), name: doc.name, slug: doc.slug } : null;
  }

  /**
   * Public storefront ids linked to a company page (the page's "Products" tab).
   * Only `public` shops are returned, so a `hidden` / `connections` storefront
   * never leaks onto a company page. Invalid id -> empty (no existence leak).
   */
  async findPublicIdsByCompanyPage(companyPageId: string): Promise<Types.ObjectId[]> {
    if (!Types.ObjectId.isValid(companyPageId)) return [];
    const docs = await this.model
      .find({ companyPageId: new Types.ObjectId(companyPageId), visibility: 'public' })
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    return docs.map((d) => d._id);
  }

  /**
   * Mark one of the owner's storefronts as their primary / pinned shop. Verifies
   * the target exists AND belongs to the caller (404 otherwise, mirroring
   * getMine), then clears `isPrimary` on ALL of the owner's shops before setting
   * it on the target so exactly one stays primary. Idempotent.
   */
  async setPrimary(ownerUserId: string, storefrontId: string): Promise<{ ok: true }> {
    await this.loadOwned(ownerUserId, storefrontId);
    const ownerObjectId = new Types.ObjectId(ownerUserId);
    await this.model.updateMany({ ownerUserId: ownerObjectId }, { $set: { isPrimary: false } });
    await this.model.updateOne(
      { _id: new Types.ObjectId(storefrontId), ownerUserId: ownerObjectId },
      { $set: { isPrimary: true } },
    );
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Storefront',
      entityId: storefrontId,
      action: 'storefront_set_primary',
      actorId: ownerUserId,
    });
    return { ok: true };
  }

  /** Clear the primary flag on one storefront without pinning another. */
  async unsetPrimary(ownerUserId: string, storefrontId: string): Promise<{ ok: true }> {
    await this.loadOwned(ownerUserId, storefrontId);
    await this.model.updateOne(
      { _id: new Types.ObjectId(storefrontId), ownerUserId: new Types.ObjectId(ownerUserId) },
      { $set: { isPrimary: false } },
    );
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Storefront',
      entityId: storefrontId,
      action: 'storefront_unset_primary',
      actorId: ownerUserId,
    });
    return { ok: true };
  }

  async update(
    ownerUserId: string,
    id: string,
    dto: UpdateStorefrontDto,
  ): Promise<StorefrontDocument> {
    const doc = await this.loadOwned(ownerUserId, id);
    if (dto.companyPageId) {
      await this.assertOwnsCompanyPage(ownerUserId, dto.companyPageId);
    }
    // Validate any new logo/banner; grandfather the shop's existing urls (they
    // predate ownership tracking). Undefined patch fields are skipped by the guard.
    await this.media.assertOwnedMedia([dto.logo, dto.banner], ownerUserId, {
      grandfatheredUrls: [doc.logo, doc.banner],
    });
    if (dto.name !== undefined) doc.name = dto.name;
    if (dto.description !== undefined) doc.description = dto.description;
    if (dto.logo !== undefined) doc.logo = dto.logo;
    if (dto.banner !== undefined) doc.banner = dto.banner;
    if (dto.categories !== undefined) doc.categories = dto.categories;
    if (dto.location !== undefined) {
      doc.location = { ...doc.location, ...dto.location };
    }
    if (dto.companyPageId !== undefined) {
      doc.companyPageId = dto.companyPageId ? new Types.ObjectId(dto.companyPageId) : null;
    }
    // ERP link is intentionally NOT mutated here (ADR-0004): it is owned by the
    // ownership-checked link / unlink path, not the generic storefront update.
    if (dto.visibility !== undefined) doc.visibility = dto.visibility;
    await doc.save();

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Storefront',
      entityId: id,
      action: 'storefront_updated',
      actorId: ownerUserId,
    });
    // Re-index on edit: a name/description/category edit refreshes the index doc;
    // a visibility flip away from `public` de-indexes (the listener re-reads the
    // live visibility and removes a now-hidden shop).
    this.emitStorefrontChanged(id);
    return doc;
  }

  async remove(ownerUserId: string, id: string): Promise<void> {
    const doc = await this.loadOwned(ownerUserId, id);
    await doc.deleteOne();
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Storefront',
      entityId: id,
      action: 'storefront_deleted',
      actorId: ownerUserId,
    });
    // De-index the deleted shop: the listener re-reads, finds it missing, and
    // removes the index doc so a deleted shop never surfaces in search.
    this.emitStorefrontChanged(id);
  }

  // ── Ownership-checked ERP linking (ADR-0004 / 2026-06-18 spec) ──────────────

  /**
   * Link this storefront to an ERP workspace — the consent + ownership-verified
   * path that REPLACES the old raw `erpWorkspaceId` DTO acceptance. The caller
   * must own BOTH the storefront (`loadOwned`, 404 otherwise) AND the workspace
   * (`isWorkspaceOwner`, `ForbiddenException` otherwise). Records the `erpLink`
   * consent sub-doc + sets `erpWorkspaceId`. Audited. Mirrors
   * `CompanyPageService.linkErpWorkspace` exactly.
   */
  async linkErpWorkspace(
    ownerUserId: string,
    storefrontId: string,
    workspaceId: string,
  ): Promise<StorefrontDocument> {
    const doc = await this.loadOwned(ownerUserId, storefrontId);
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
      entityType: 'Storefront',
      entityId: storefrontId,
      action: 'storefront_erp_linked',
      actorId: ownerUserId,
      meta: { workspaceId },
    });
    this.posthog?.capture({
      distinctId: ownerUserId,
      event: 'connect.storefront_erp_linked',
      properties: { storefrontId, workspaceId },
    });
    return doc;
  }

  /**
   * Unlink this storefront from its ERP workspace (owner action). Sets the
   * consent record to `revoked` and clears `erpWorkspaceId` so the badge drops
   * immediately. Tolerates an already-unlinked shop. Audited. The deletion
   * cascades apply the same clear with `actor=system`.
   */
  async unlinkErpWorkspace(ownerUserId: string, storefrontId: string): Promise<StorefrontDocument> {
    const doc = await this.loadOwned(ownerUserId, storefrontId);
    doc.erpWorkspaceId = null;
    doc.erpLink = doc.erpLink ? { ...doc.erpLink, status: 'revoked', linkedAt: null } : null;
    await doc.save();

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Storefront',
      entityId: storefrontId,
      action: 'storefront_erp_unlinked',
      actorId: ownerUserId,
    });
    this.posthog?.capture({
      distinctId: ownerUserId,
      event: 'connect.storefront_erp_unlinked',
      properties: { storefrontId },
    });
    return doc;
  }

  /**
   * Verify the caller owns the workspace they are linking. Loads the workspace
   * and applies the shared `isWorkspaceOwner` check; throws `ForbiddenException`
   * for a non-owner / missing workspace.
   */
  private async assertOwnsWorkspace(ownerUserId: string, workspaceId: string): Promise<void> {
    if (!this.workspaceModel) {
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

  /** Public read by slug. `hidden` shops 404 to non-owners; ERP badge derived. */
  async getPublicBySlug(slug: string, viewerUserId?: string): Promise<PublicStorefront> {
    const storefront = await this.model
      .findOne({ slug })
      .lean<Storefront & { _id: Types.ObjectId; ownerUserId: Types.ObjectId }>()
      .exec();
    if (!storefront) {
      throw new NotFoundException('Storefront not found');
    }
    const isOwner = !!viewerUserId && String(storefront.ownerUserId) === String(viewerUserId);
    if (storefront.visibility === 'hidden' && !isOwner) {
      throw new NotFoundException('Storefront not found');
    }
    // Over-limit suppression (hide_newest): a suppressed storefront reads as
    // not-found to the public; the owner always sees their own. No-op under freeze.
    if (this.overLimit && !isOwner) {
      const suppressed = await this.overLimit.getSuppressedIds(
        String(storefront.ownerUserId),
        'storefront',
      );
      if (suppressed.includes(String(storefront._id))) {
        throw new NotFoundException('Storefront not found');
      }
    }

    // Consent-gated ERP badge (ADR-0004 / 2026-06-18): the derivation runs ONLY
    // when the storefront's own `erpLink.status === 'verified'` (the owner linked
    // it through the ownership-checked, consented path). A dangling
    // `erpWorkspaceId`, or a revoked / never-consented link, yields no badge.
    // Public read reveals only `{ linked, since }` (the year on the web).
    let erpLink: PublicErpLink = { linked: false, since: null };
    try {
      const status = await this.erpLink.getConsentedWorkspaceStatus(storefront);
      erpLink = { linked: !!status?.linked, since: status?.since ?? null };
    } catch (e) {
      const err = e as { message?: string };
      this.logger.warn(`ERP-link derive failed for storefront ${slug}: ${err.message}`);
    }
    // Owner-derived demo flag for the "Sample" disclosure badge (reads the same
    // User.isDemo as the directory card + the shared feed/search down-rank). One
    // light projected read; absent model (unit tests) reads as real.
    const isDemo = await this.isOwnerDemo(storefront.ownerUserId);
    return { storefront, erpLink, isDemo };
  }

  /**
   * Whether a storefront owner is a seeded demo/sample account (User.isDemo).
   * One projected read; returns false when the User model is absent (positional
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

  // ── Company-page <-> storefront link ───────────────────────────────────────
  // One storefront per company page (the page's attached store). Source of truth
  // is Storefront.companyPageId; the partial unique index in storefront.schema.ts
  // is the integrity backstop. Used by CompanyPageController's :pageId/store
  // endpoints, which the web "Store" tab on the company-page manage console calls.

  /**
   * Verify the caller owns the page; 404 otherwise. Returns the lean page doc.
   * Person-centric ownership: ownerUserId must equal the caller. Mirrors
   * CompanyPageService.loadOwned but kept here so the link methods are
   * self-contained (no cross-service injection).
   */
  private async assertOwnedPage(userId: string, pageId: string) {
    // findOne returns a Query that is directly awaitable (no .exec() needed); the
    // mongodb mock in the unit test resolves it the same way.
    const page = Types.ObjectId.isValid(pageId)
      ? await this.companyPageModel.findOne({
          _id: new Types.ObjectId(pageId),
          ownerUserId: new Types.ObjectId(userId),
        })
      : null;
    if (!page) throw new NotFoundException('Company page not found');
    return page;
  }

  /**
   * The single storefront attached to a page (0 or 1). `ownerView` ignores
   * visibility (manage console); public callers pass ownerView=false so a
   * non-public store never leaks onto the page. Invalid id -> null.
   */
  async getAttachedStorefront(pageId: string, ownerView = false): Promise<Storefront | null> {
    if (!Types.ObjectId.isValid(pageId)) return null;
    const filter: FilterQuery<StorefrontDocument> = {
      companyPageId: new Types.ObjectId(pageId),
    };
    if (!ownerView) filter.visibility = 'public';
    return this.model.findOne(filter).lean<Storefront>().exec();
  }

  /**
   * Owner GET for the page's attached store: verifies ownership first (so the
   * :pageId/store GET endpoint cannot read another owner's page link), then
   * returns the attached store (any visibility) or null. Links to the web
   * CompanyPageStoreTab via getCompanyPageStore.
   */
  async getAttachedStoreForOwner(userId: string, pageId: string): Promise<Storefront | null> {
    await this.assertOwnedPage(userId, pageId);
    return this.getAttachedStorefront(pageId, true);
  }

  /**
   * Attach (or swap) a storefront to a page. Caller must own BOTH the page and
   * the store (404 otherwise). Rejects a store already linked to a DIFFERENT page
   * (no silent move). Clears any other store currently on this page first
   * (one-store-per-page swap), then links the target. Idempotent when the store
   * is already this page's store. Audits `storefront_linked_page`.
   * Gotcha: keep in sync with the partial unique index in storefront.schema.ts.
   */
  async attachStorefrontToPage(userId: string, pageId: string, storefrontId: string) {
    await this.assertOwnedPage(userId, pageId);
    const store = Types.ObjectId.isValid(storefrontId)
      ? await this.model.findOne({
          _id: new Types.ObjectId(storefrontId),
          ownerUserId: new Types.ObjectId(userId),
        })
      : null;
    if (!store) throw new NotFoundException('Storefront not found');
    const pageObjId = new Types.ObjectId(pageId);
    if (store.companyPageId && String(store.companyPageId) !== String(pageObjId)) {
      throw new BadRequestException('This store is attached to another page');
    }
    // Clear any other store currently on this page (the swap), then link target.
    await this.model.updateMany(
      { companyPageId: pageObjId, _id: { $ne: store._id } },
      { $set: { companyPageId: null } },
    );
    await this.model.updateOne({ _id: store._id }, { $set: { companyPageId: pageObjId } });
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Storefront',
      entityId: String(store._id),
      action: 'storefront_linked_page',
      actorId: userId,
      meta: { pageId },
    });
    return { linked: true };
  }

  /**
   * Unlink the page's attached store (set its companyPageId to null). Caller must
   * own the page. Tolerates a page with no attached store (no-op, no audit).
   * Audits `storefront_unlinked_page` only when something was actually unlinked.
   */
  async unlinkStorefrontFromPage(userId: string, pageId: string) {
    await this.assertOwnedPage(userId, pageId);
    const res = await this.model.updateOne(
      {
        companyPageId: new Types.ObjectId(pageId),
        ownerUserId: new Types.ObjectId(userId),
      },
      { $set: { companyPageId: null } },
    );
    if (res.matchedCount > 0) {
      await this.audit.logEvent({
        module: AppModule.CONNECT,
        entityType: 'CompanyPage',
        entityId: pageId,
        action: 'storefront_unlinked_page',
        actorId: userId,
      });
    }
    return { linked: false };
  }

  /** Verify the caller owns the company page they are linking. */
  private async assertOwnsCompanyPage(ownerUserId: string, companyPageId: string): Promise<void> {
    const cp = await this.companyPageModel
      .findById(companyPageId)
      .select('ownerUserId')
      .lean<{ ownerUserId: Types.ObjectId }>()
      .exec();
    if (!cp || String(cp.ownerUserId) !== String(ownerUserId)) {
      throw new BadRequestException('Company page not found');
    }
  }

  private async loadOwned(ownerUserId: string, id: string): Promise<StorefrontDocument> {
    const doc = await this.model.findById(id);
    if (!doc || String(doc.ownerUserId) !== String(ownerUserId)) {
      throw new NotFoundException('Storefront not found');
    }
    return doc;
  }
}
