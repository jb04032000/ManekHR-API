import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { Listing, type ListingDocument } from '../schemas/listing.schema';
import { AuditService } from '../../../audit/audit.service';
import { AppModule } from '../../../../common/enums/modules.enum';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import {
  CONNECT_LISTING_CHANGED,
  type ConnectListingChangedEvent,
} from '../events/connect-listing.events';
import {
  CONTENT_TAKEDOWN_EVENT,
  type ContentTakedownEvent,
} from '../../content-reports/content-reports.constants';

/**
 * ManekHR Connect Marketplace -- admin listing moderation (Phase M1.3).
 *
 * Platform-admin review of seller listings. Mirrors the ads review console
 * (AdsAdminService.approve/reject). An admin may moderate any listing, so there
 * is no owner check here -- the admin controller gates on IsAdminGuard, and the
 * admin id is always the JWT subject (never the body) so the audit trail
 * reflects the real operator. Approving a listing publishes it (`active`);
 * rejecting records a reason the owner can see.
 */
@Injectable()
export class ListingModerationService {
  constructor(
    @InjectModel(Listing.name)
    private readonly listingModel: Model<ListingDocument>,
    private readonly audit: AuditService,
    private readonly eventEmitter: EventEmitter2,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
  ) {}

  /** Fire the listing-changed event so SearchService re-indexes / de-indexes. */
  private emitChanged(listingId: string | Types.ObjectId): void {
    const payload: ConnectListingChangedEvent = { listingId: String(listingId) };
    this.eventEmitter.emit(CONNECT_LISTING_CHANGED, payload);
  }

  /** Listings awaiting review (moderationStatus: pending), newest first. */
  async listPending(): Promise<Listing[]> {
    return this.listingModel
      .find({ moderationStatus: 'pending' })
      .sort({ createdAt: -1 })
      .lean<Listing[]>()
      .exec();
  }

  /** Approve a listing: moderation approved and it goes live (active). */
  async approve(id: string, adminUserId: string, note?: string): Promise<ListingDocument> {
    const listing = await this.load(id);
    listing.moderationStatus = 'approved';
    listing.status = 'active';
    listing.rejectionReason = null;
    await listing.save();

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Listing',
      entityId: id,
      action: 'listing_approved',
      actorId: adminUserId,
      meta: { ...(note !== undefined && { note }) },
    });
    this.posthog?.capture({
      distinctId: adminUserId,
      event: 'connect.listing_approved',
      properties: { listingId: id },
    });
    this.emitChanged(id);
    return listing;
  }

  /** Reject a listing: moderation rejected, status rejected, reason recorded. */
  async reject(id: string, adminUserId: string, reason: string): Promise<ListingDocument> {
    const listing = await this.load(id);
    listing.moderationStatus = 'rejected';
    listing.status = 'rejected';
    listing.rejectionReason = reason;
    await listing.save();

    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'Listing',
      entityId: id,
      action: 'listing_rejected',
      actorId: adminUserId,
      reason,
    });
    this.posthog?.capture({
      distinctId: adminUserId,
      event: 'connect.listing_rejected',
      properties: { listingId: id, reason },
    });
    this.emitChanged(id);
    return listing;
  }

  /**
   * Moderation takedown (content-reports "Remove"). When a reported LISTING is
   * actioned, reuse `reject` so it leaves the marketplace + search and the owner
   * sees the reason. Best-effort: a missing listing is a no-op and never throws
   * out of the event handler. Links: content-reports.service emits the event.
   */
  @OnEvent(CONTENT_TAKEDOWN_EVENT)
  async onContentTakedown(e: ContentTakedownEvent): Promise<void> {
    if (e.targetType !== 'listing') return;
    try {
      await this.reject(e.targetId, e.actorId, 'Removed by moderation (reported content).');
    } catch {
      /* best-effort takedown; an event handler must never throw */
    }
  }

  private async load(id: string): Promise<ListingDocument> {
    const listing = await this.listingModel.findById(id);
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    return listing;
  }
}
