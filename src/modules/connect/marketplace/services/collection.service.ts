import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Collection, type CollectionDocument } from '../schemas/collection.schema';
import { Listing, type ListingDocument } from '../schemas/listing.schema';
import { StorefrontService } from '../../entities/services/storefront.service';
import { generateUniqueEntitySlug } from '../../entities/entity-slug.util';
import { AuditService } from '../../../audit/audit.service';
import { AppModule } from '../../../../common/enums/modules.enum';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import type { CreateCollectionDto, UpdateCollectionDto } from '../dto/collection.dto';
import { MediaOwnershipService } from '../../../uploads/services/media-ownership.service';

/** A shop may organize its products into at most this many collections. */
export const MAX_COLLECTIONS = 50;

/** Owner-facing collection row: the document plus its product tally (any status). */
export interface CollectionWithCount {
  collection: Collection;
  productCount: number;
}

/** Public collection slice for the storefront browser. `productCount` is LIVE only. */
export interface PublicCollection {
  id: string;
  title: string;
  slug: string;
  description: string;
  coverImage: string;
  productCount: number;
}

/**
 * ManekHR Connect Marketplace -- Shop Collections service.
 *
 * Owner-curated, shop-scoped product groups. PERSON-CENTRIC: every write derives
 * the owner from the JWT and verifies ownership of the collection AND of every
 * listing / storefront it touches, so no cross-user or cross-shop write is
 * possible. Membership lives on `Listing.collectionIds` (the source of truth);
 * `Collection.productOrder` is advisory ordering only.
 */
@Injectable()
export class CollectionService {
  constructor(
    @InjectModel(Collection.name)
    private readonly model: Model<CollectionDocument>,
    @InjectModel(Listing.name)
    private readonly listingModel: Model<ListingDocument>,
    private readonly storefronts: StorefrontService,
    private readonly audit: AuditService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
    /**
     * Shared media-URL ownership guard (uploads module). Verifies the caller
     * uploaded the collection cover image before it is persisted. @Optional so
     * positional unit-test constructors keep working; production DI injects it.
     */
    @Optional() private readonly media?: MediaOwnershipService,
  ) {}

  /** Create a collection in one of the owner's shops (capped at MAX_COLLECTIONS). */
  async create(
    ownerUserId: string,
    storefrontId: string,
    dto: CreateCollectionDto,
  ): Promise<CollectionDocument> {
    await this.storefronts.getMine(ownerUserId, storefrontId); // 404 if not owned
    // Ownership-check the cover image (if any) via the shared media-ownership
    // guard (uploads module) before persisting, so a caller can only attach a
    // file they actually uploaded.
    await this.media.assertOwnedSingle(dto.coverImage, ownerUserId);
    const storefrontObjectId = new Types.ObjectId(storefrontId);

    const count = await this.model.countDocuments({ storefrontId: storefrontObjectId });
    if (count >= MAX_COLLECTIONS) {
      throw new ForbiddenException(`A shop can have at most ${MAX_COLLECTIONS} collections`);
    }

    const slug = await generateUniqueEntitySlug(
      dto.title,
      (s) =>
        this.model.exists({ storefrontId: storefrontObjectId, slug: s }).then((r) => r !== null),
      'collection',
    );
    // New collection sorts after the current last one.
    const last = await this.model
      .findOne({ storefrontId: storefrontObjectId })
      .sort({ sortIndex: -1 })
      .select('sortIndex')
      .lean<{ sortIndex: number }>()
      .exec();

    const doc = await this.model.create({
      storefrontId: storefrontObjectId,
      ownerUserId: new Types.ObjectId(ownerUserId),
      title: dto.title,
      slug,
      description: dto.description ?? '',
      coverImage: dto.coverImage ?? '',
      sortIndex: (last?.sortIndex ?? -1) + 1,
      productOrder: [],
    });

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Collection',
      entityId: String(doc._id),
      action: 'collection_created',
      actorId: ownerUserId,
      meta: { storefrontId },
    });
    this.posthog?.capture({
      distinctId: ownerUserId,
      event: 'connect.collection_created',
      properties: { collectionId: String(doc._id), storefrontId },
    });
    return doc;
  }

  /** The shop's collections (owner view), ordered, each with its product tally. */
  async listMine(ownerUserId: string, storefrontId: string): Promise<CollectionWithCount[]> {
    await this.storefronts.getMine(ownerUserId, storefrontId);
    const storefrontObjectId = new Types.ObjectId(storefrontId);
    const collections = await this.model
      .find({ storefrontId: storefrontObjectId })
      .sort({ sortIndex: 1 })
      .lean<Collection[]>()
      .exec();
    const counts = await this.countByCollection(storefrontObjectId, false);
    return collections.map((collection) => ({
      collection,
      productCount: counts.get(String((collection as { _id: Types.ObjectId })._id)) ?? 0,
    }));
  }

  /** Rename / re-describe / re-cover a collection (owner-only). Title -> re-slug. */
  async update(
    id: string,
    ownerUserId: string,
    dto: UpdateCollectionDto,
  ): Promise<CollectionDocument> {
    const doc = await this.loadOwned(id, ownerUserId);
    // When the cover image changes, ownership-check the new url via the shared
    // media-ownership guard (uploads module). The current cover is grandfathered
    // (already accepted), so only a newly-set url needs an ownership record.
    if (dto.coverImage !== undefined) {
      await this.media.assertOwnedSingle(dto.coverImage, ownerUserId, {
        grandfatheredUrls: [doc.coverImage],
      });
    }
    if (dto.title !== undefined && dto.title !== doc.title) {
      doc.title = dto.title;
      doc.slug = await generateUniqueEntitySlug(
        dto.title,
        (s) =>
          this.model
            .exists({ storefrontId: doc.storefrontId, slug: s, _id: { $ne: doc._id } })
            .then((r) => r !== null),
        'collection',
      );
    }
    if (dto.description !== undefined) doc.description = dto.description;
    if (dto.coverImage !== undefined) doc.coverImage = dto.coverImage;
    await doc.save();
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Collection',
      entityId: id,
      action: 'collection_updated',
      actorId: ownerUserId,
    });
    return doc;
  }

  /** Delete a collection: pull it from every member product, then remove it. */
  async remove(id: string, ownerUserId: string): Promise<{ deleted: boolean; id: string }> {
    const doc = await this.loadOwned(id, ownerUserId);
    await this.listingModel.updateMany(
      { storefrontId: doc.storefrontId, collectionIds: doc._id },
      { $pull: { collectionIds: doc._id } },
    );
    await this.model.deleteOne({ _id: doc._id });
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Collection',
      entityId: id,
      action: 'collection_deleted',
      actorId: ownerUserId,
    });
    return { deleted: true, id };
  }

  /** Reorder the shop's collections from the given full ordered id list. */
  async reorderCollections(
    ownerUserId: string,
    storefrontId: string,
    orderedIds: string[],
  ): Promise<{ ok: true }> {
    await this.storefronts.getMine(ownerUserId, storefrontId);
    const storefrontObjectId = new Types.ObjectId(storefrontId);
    const owned = await this.model
      .find({ storefrontId: storefrontObjectId })
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    const ownedSet = new Set(owned.map((c) => String(c._id)));
    // Apply the requested order to ids that belong to the shop; ignore strangers.
    let sortIndex = 0;
    for (const id of orderedIds) {
      if (!ownedSet.has(id)) continue;
      await this.model.updateOne({ _id: new Types.ObjectId(id) }, { $set: { sortIndex } });
      sortIndex += 1;
    }
    return { ok: true };
  }

  /**
   * Set the exact members + order of a collection (the manage-a-collection view).
   * Diffs against current members: adds the collection id to newly-included
   * listings, pulls it from removed ones; writes `productOrder` to the given order.
   * Only the caller's listings in THIS shop are honored (others are dropped).
   */
  async setProducts(
    collectionId: string,
    ownerUserId: string,
    listingIds: string[],
  ): Promise<CollectionDocument> {
    const doc = await this.loadOwned(collectionId, ownerUserId);
    const validIds = await this.filterOwnedShopListings(
      doc.storefrontId as Types.ObjectId,
      ownerUserId,
      listingIds,
    );
    const validObjectIds = validIds.map((id) => new Types.ObjectId(id));

    const currentMembers = await this.listingModel
      .find({ storefrontId: doc.storefrontId, collectionIds: doc._id })
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    const currentSet = new Set(currentMembers.map((l) => String(l._id)));
    const nextSet = new Set(validIds);

    const toAdd = validObjectIds.filter((id) => !currentSet.has(String(id)));
    const toRemove = currentMembers.map((l) => l._id).filter((id) => !nextSet.has(String(id)));

    if (toAdd.length) {
      await this.listingModel.updateMany(
        { _id: { $in: toAdd } },
        { $addToSet: { collectionIds: doc._id } },
      );
    }
    if (toRemove.length) {
      await this.listingModel.updateMany(
        { _id: { $in: toRemove } },
        { $pull: { collectionIds: doc._id } },
      );
    }
    doc.productOrder = validObjectIds;
    await doc.save();
    return doc;
  }

  /** Bulk-add products to a collection (union; never removes). */
  async addProductsBulk(
    collectionId: string,
    ownerUserId: string,
    listingIds: string[],
  ): Promise<{ added: number }> {
    const doc = await this.loadOwned(collectionId, ownerUserId);
    const validIds = await this.filterOwnedShopListings(
      doc.storefrontId as Types.ObjectId,
      ownerUserId,
      listingIds,
    );
    if (!validIds.length) return { added: 0 };
    const validObjectIds = validIds.map((id) => new Types.ObjectId(id));
    await this.listingModel.updateMany(
      { _id: { $in: validObjectIds } },
      { $addToSet: { collectionIds: doc._id } },
    );
    // Append newcomers to the advisory order (keep existing order stable).
    const existing = new Set(doc.productOrder.map((id) => String(id)));
    for (const id of validObjectIds) {
      if (!existing.has(String(id))) doc.productOrder.push(id);
    }
    await doc.save();
    return { added: validIds.length };
  }

  /**
   * Set which collections a single product belongs to (the product-editor path).
   * Diffs the listing's `collectionIds`; maintains each collection's advisory
   * `productOrder`. Only the caller's collections in the SAME shop are honored.
   */
  async setListingCollections(
    listingId: string,
    ownerUserId: string,
    collectionIds: string[],
  ): Promise<{ collectionIds: string[] }> {
    const listing = await this.listingModel.findById(listingId);
    if (!listing || String(listing.ownerUserId) !== ownerUserId) {
      throw new NotFoundException('Listing not found');
    }
    // Keep only collections owned by the caller AND in the listing's shop.
    const owned = await this.model
      .find({
        _id: { $in: collectionIds.map((id) => new Types.ObjectId(id)) },
        ownerUserId: new Types.ObjectId(ownerUserId),
        storefrontId: listing.storefrontId ?? undefined,
      })
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    const validObjectIds = owned.map((c) => c._id);
    const validSet = new Set(validObjectIds.map((id) => String(id)));
    const currentSet = new Set((listing.collectionIds ?? []).map((id) => String(id)));

    const added = validObjectIds.filter((id) => !currentSet.has(String(id)));
    const removed = (listing.collectionIds ?? []).filter((id) => !validSet.has(String(id)));

    listing.collectionIds = validObjectIds;
    await listing.save();

    // Maintain advisory order on the touched collections.
    if (added.length) {
      await this.model.updateMany(
        { _id: { $in: added } },
        { $addToSet: { productOrder: listing._id } },
      );
    }
    if (removed.length) {
      await this.model.updateMany(
        { _id: { $in: removed } },
        { $pull: { productOrder: listing._id } },
      );
    }
    return { collectionIds: validObjectIds.map((id) => String(id)) };
  }

  /** Public collections for a shop, ordered, each with its LIVE product count. */
  async listPublicByStorefront(storefrontId: string): Promise<PublicCollection[]> {
    if (!Types.ObjectId.isValid(storefrontId)) return [];
    const storefrontObjectId = new Types.ObjectId(storefrontId);
    const collections = await this.model
      .find({ storefrontId: storefrontObjectId })
      .sort({ sortIndex: 1 })
      .lean<Array<Collection & { _id: Types.ObjectId }>>()
      .exec();
    if (!collections.length) return [];
    const counts = await this.countByCollection(storefrontObjectId, true);
    return collections.map((c) => ({
      id: String(c._id),
      title: c.title,
      slug: c.slug,
      description: c.description ?? '',
      coverImage: c.coverImage ?? '',
      productCount: counts.get(String(c._id)) ?? 0,
    }));
  }

  /**
   * Tally products per collection for one shop in a single query. `liveOnly`
   * counts only active + approved listings (the public count); otherwise every
   * listing (the owner count).
   */
  private async countByCollection(
    storefrontId: Types.ObjectId,
    liveOnly: boolean,
  ): Promise<Map<string, number>> {
    const filter: Record<string, unknown> = { storefrontId, collectionIds: { $ne: [] } };
    if (liveOnly) {
      filter.status = 'active';
      filter.moderationStatus = 'approved';
    }
    const rows = await this.listingModel
      .find(filter)
      .select('collectionIds')
      .lean<{ collectionIds?: Types.ObjectId[] }[]>()
      .exec();
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const cid of row.collectionIds ?? []) {
        const key = String(cid);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  }

  /** Listing ids that the caller owns AND that live in the given shop. */
  private async filterOwnedShopListings(
    storefrontId: Types.ObjectId,
    ownerUserId: string,
    listingIds: string[],
  ): Promise<string[]> {
    const ids = listingIds.filter((id) => Types.ObjectId.isValid(id));
    if (!ids.length) return [];
    const found = await this.listingModel
      .find({
        _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
        ownerUserId: new Types.ObjectId(ownerUserId),
        storefrontId,
      })
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    const foundSet = new Set(found.map((l) => String(l._id)));
    // Preserve the caller's given order, dropping any invalid ids.
    return ids.filter((id) => foundSet.has(id));
  }

  private async loadOwned(id: string, ownerUserId: string): Promise<CollectionDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Collection not found');
    const doc = await this.model.findById(id);
    if (!doc || String(doc.ownerUserId) !== ownerUserId) {
      throw new NotFoundException('Collection not found');
    }
    return doc;
  }
}
