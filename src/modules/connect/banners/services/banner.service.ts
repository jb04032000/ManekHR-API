import { Injectable, Logger, NotFoundException, Optional, Inject } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConnectBanner } from '../schemas/connect-banner.schema';
import { PrivateMediaService } from '../../../uploads/services/private-media.service';
import { AuditService } from '../../../audit/audit.service';
import { AppModule } from '../../../../common/enums/modules.enum';
import { PostHogService } from '../../../../common/posthog/posthog.service';
import { isBannerLive } from '../lib/banner-live-window';
import { env } from '../../../../config/env';
import { CreateBannerDto } from '../dto/create-banner.dto';
import { UpdateBannerDto } from '../dto/update-banner.dto';
import { ReorderBannersDto } from '../dto/reorder-banners.dto';

/** Public carousel item — raw refs are never exposed; imageUrl is signed. */
export interface PublicBanner {
  id: string;
  imageUrl: string;
  linkUrl: string;
  alt: string;
  order: number;
}

/** Admin row — full fields (signed imageUrl for preview) for the console table. */
export interface AdminBanner extends PublicBanner {
  title: string;
  isActive: boolean;
  liveFrom: string | null;
  liveUntil: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Lean shape of a stored banner doc (as returned by `.lean()`). */
interface BannerLean {
  _id: Types.ObjectId;
  imageUrl: string;
  linkUrl: string;
  title: string;
  alt: string;
  order: number;
  isActive: boolean;
  liveFrom: Date | null;
  liveUntil: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * ConnectBanner service — the public feed-carousel read plus platform-admin
 * CRUD/reorder/toggle. Public read applies the pure `isBannerLive` window
 * filter (banner-live-window.ts) and signs images via PrivateMediaService.
 * Every admin write is audited under `AppModule.CONNECT_BANNERS` and emits a
 * PostHog `connect.banner_*` event. Cross-links: banner-public.controller.ts,
 * banner-admin.controller.ts.
 */
@Injectable()
export class BannerService {
  private readonly logger = new Logger(BannerService.name);

  constructor(
    @InjectModel(ConnectBanner.name)
    private readonly bannerModel: Model<ConnectBanner>,
    private readonly privateMedia: PrivateMediaService,
    private readonly audit: AuditService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public read
  // ---------------------------------------------------------------------------

  /**
   * The live carousel: active banners inside their [liveFrom, liveUntil] window,
   * sorted by order, images signed. Returns `[]` when the feature flag is off or
   * nothing is live (the FE renders nothing on an empty list). `now` is injected
   * for deterministic tests.
   */
  async listActive(now: Date = new Date()): Promise<PublicBanner[]> {
    if (!env.connectBanners.enabled) return [];

    const docs = await this.bannerModel
      .find({ isActive: true })
      .sort({ order: 1, createdAt: 1 })
      .lean<BannerLean[]>()
      .exec();

    const live = docs.filter((d) => isBannerLive(d, now));
    if (live.length === 0) return [];

    const signed = await this.privateMedia.signMany(live.map((d) => d.imageUrl));
    return live.map((d) => ({
      id: d._id.toString(),
      imageUrl: this.privateMedia.resolve(d.imageUrl, signed) ?? '',
      linkUrl: d.linkUrl ?? '',
      alt: (d.alt || d.title || '').trim(),
      order: d.order ?? 0,
    }));
  }

  // ---------------------------------------------------------------------------
  // Admin
  // ---------------------------------------------------------------------------

  /** Full banner list for the admin console (all states), sorted by order. */
  async listAdmin(): Promise<AdminBanner[]> {
    const docs = await this.bannerModel
      .find({})
      .sort({ order: 1, createdAt: 1 })
      .lean<BannerLean[]>()
      .exec();

    const signed = await this.privateMedia.signMany(docs.map((d) => d.imageUrl));
    return docs.map((d) => this.toAdmin(d, signed));
  }

  async create(dto: CreateBannerDto, adminId: string): Promise<AdminBanner> {
    // Collapse any signed URL back to its canonical ref before persisting.
    const imageUrl = this.privateMedia.normalizeIncomingRef(dto.imageUrl) ?? dto.imageUrl;
    const created = await this.bannerModel.create({
      imageUrl,
      linkUrl: dto.linkUrl ?? '',
      title: dto.title,
      alt: dto.alt ?? '',
      order: dto.order ?? 0,
      isActive: dto.isActive ?? true,
      liveFrom: dto.liveFrom ? new Date(dto.liveFrom) : null,
      liveUntil: dto.liveUntil ? new Date(dto.liveUntil) : null,
    });
    await this.record('create', created._id, adminId, { title: dto.title });
    return this.toAdmin(created.toObject() as unknown as BannerLean);
  }

  async update(id: string, dto: UpdateBannerDto, adminId: string): Promise<AdminBanner> {
    const patch: Record<string, unknown> = {};
    if (dto.imageUrl !== undefined)
      patch.imageUrl = this.privateMedia.normalizeIncomingRef(dto.imageUrl) ?? dto.imageUrl;
    if (dto.linkUrl !== undefined) patch.linkUrl = dto.linkUrl;
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.alt !== undefined) patch.alt = dto.alt;
    if (dto.order !== undefined) patch.order = dto.order;
    if (dto.isActive !== undefined) patch.isActive = dto.isActive;
    if (dto.liveFrom !== undefined) patch.liveFrom = dto.liveFrom ? new Date(dto.liveFrom) : null;
    if (dto.liveUntil !== undefined)
      patch.liveUntil = dto.liveUntil ? new Date(dto.liveUntil) : null;

    const updated = await this.bannerModel
      .findByIdAndUpdate(id, { $set: patch }, { new: true })
      .lean<BannerLean>()
      .exec();
    if (!updated) throw new NotFoundException('Banner not found');

    await this.record('update', updated._id, adminId, { fields: Object.keys(patch) });
    return this.toAdmin(updated);
  }

  async remove(id: string, adminId: string): Promise<{ deleted: true }> {
    const deleted = await this.bannerModel.findByIdAndDelete(id).lean<BannerLean>().exec();
    if (!deleted) throw new NotFoundException('Banner not found');
    await this.record('delete', deleted._id, adminId, { title: deleted.title });
    return { deleted: true };
  }

  /** Toggle a banner active/inactive without touching any other field. */
  async toggle(id: string, isActive: boolean, adminId: string): Promise<AdminBanner> {
    const updated = await this.bannerModel
      .findByIdAndUpdate(id, { $set: { isActive } }, { new: true })
      .lean<BannerLean>()
      .exec();
    if (!updated) throw new NotFoundException('Banner not found');
    await this.record('toggle', updated._id, adminId, { isActive });
    return this.toAdmin(updated);
  }

  /**
   * Persist a new ordering. `orderedIds` is the desired top-to-bottom sequence;
   * each banner's `order` is set to its index. Unknown ids are ignored.
   */
  async reorder(dto: ReorderBannersDto, adminId: string): Promise<AdminBanner[]> {
    await Promise.all(
      dto.orderedIds.map((id, index) =>
        this.bannerModel.updateOne({ _id: id }, { $set: { order: index } }).exec(),
      ),
    );
    await this.record('reorder', dto.orderedIds[0] ?? new Types.ObjectId(), adminId, {
      count: dto.orderedIds.length,
    });
    return this.listAdmin();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Audit + analytics for one admin write. Failures never break the write. */
  private async record(
    action: string,
    entityId: string | Types.ObjectId,
    adminId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.audit.logEvent({
        workspaceId: null, // platform-level content — no tenant
        module: AppModule.CONNECT_BANNERS,
        entityType: 'connect_banner',
        entityId,
        action,
        actorId: adminId,
        meta,
      });
    } catch (err) {
      this.logger.error(`banner audit (${action}) failed: ${(err as Error)?.message}`);
    }
    this.posthog?.capture({
      distinctId: adminId,
      event: `connect.banner_${action}`,
      properties: { bannerId: entityId.toString(), ...meta },
    });
  }

  /** Map a stored doc to the admin shape (signed imageUrl for preview). */
  private toAdmin(d: BannerLean, signed?: Map<string, string>): AdminBanner {
    const imageUrl = signed ? (this.privateMedia.resolve(d.imageUrl, signed) ?? '') : d.imageUrl;
    return {
      id: d._id.toString(),
      imageUrl,
      linkUrl: d.linkUrl ?? '',
      title: d.title,
      alt: (d.alt || d.title || '').trim(),
      order: d.order ?? 0,
      isActive: d.isActive,
      liveFrom: d.liveFrom ? d.liveFrom.toISOString() : null,
      liveUntil: d.liveUntil ? d.liveUntil.toISOString() : null,
      createdAt: d.createdAt ? d.createdAt.toISOString() : null,
      updatedAt: d.updatedAt ? d.updatedAt.toISOString() : null,
    };
  }
}
