import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConnectViewDaily, type ConnectViewTargetType } from '../schemas/connect-view-daily.schema';
import { ConnectViewSeen } from '../schemas/connect-view-seen.schema';
import { Storefront } from '../../entities/schemas/storefront.schema';
import { Listing } from '../../marketplace/schemas/listing.schema';

export interface StorefrontViewSummary {
  /** Views in the last 7 days. */
  views7d: number;
  /** Views in the last 30 days. */
  views30d: number;
  /** 30 ascending, zero-filled daily points for a sparkline. */
  series: { date: string; count: number }[];
  /** Per-listing view counts (last 7 days) for this storefront's products. */
  byListing: { listingId: string; views7d: number }[];
}

export interface ProfileViewSummary {
  views7d: number;
  views30d: number;
  total: number;
}

/** UTC 'YYYY-MM-DD' for a date. */
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The last `days` UTC calendar days ending at `end`, ascending. */
function dayList(end: Date, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(utcDay(d));
  }
  return out;
}

/**
 * ConnectViewService -- records storefront / product views (deduped per viewer
 * per UTC day) and rolls them up for the storefront analytics dashboard.
 *
 * Recording is best-effort: any failure is swallowed (a missed view must never
 * break a page render). The summary is strictly owner-scoped -- only the
 * storefront's owner can read its analytics.
 */
@Injectable()
export class ConnectViewService {
  private readonly logger = new Logger(ConnectViewService.name);

  constructor(
    @InjectModel(ConnectViewDaily.name) private readonly daily: Model<ConnectViewDaily>,
    @InjectModel(ConnectViewSeen.name) private readonly seen: Model<ConnectViewSeen>,
    @InjectModel(Storefront.name) private readonly storefronts: Model<Storefront>,
    @InjectModel(Listing.name) private readonly listings: Model<Listing>,
  ) {}

  async recordView(
    viewerUserId: string,
    targetType: ConnectViewTargetType,
    targetId: string,
  ): Promise<{ ok: true; counted: boolean }> {
    try {
      const date = utcDay(new Date());
      const tId = new Types.ObjectId(targetId);
      const vId = new Types.ObjectId(viewerUserId);
      try {
        await this.seen.create({ targetType, targetId: tId, viewerUserId: vId, date });
      } catch (e) {
        // Already counted this viewer for this target today -- no increment.
        if ((e as { code?: number }).code === 11000) return { ok: true, counted: false };
        throw e;
      }
      await this.daily.updateOne(
        { targetType, targetId: tId, date },
        { $inc: { count: 1 } },
        { upsert: true },
      );
      return { ok: true, counted: true };
    } catch (e) {
      this.logger.warn(`recordView failed (non-fatal): ${(e as Error).message}`);
      return { ok: true, counted: false };
    }
  }

  async storefrontSummary(
    ownerUserId: string,
    storefrontId: string,
  ): Promise<StorefrontViewSummary> {
    const shop = await this.storefronts
      .findOne({
        _id: new Types.ObjectId(storefrontId),
        ownerUserId: new Types.ObjectId(ownerUserId),
      })
      .lean()
      .exec();
    if (!shop) throw new NotFoundException('Storefront not found');

    const today = new Date();
    const days30 = dayList(today, 30);
    const windowStart = days30[0];
    const sId = new Types.ObjectId(storefrontId);

    const rows = await this.daily
      .find({ targetType: 'storefront', targetId: sId, date: { $gte: windowStart } })
      .lean()
      .exec();
    const byDate = new Map<string, number>();
    rows.forEach((r) => byDate.set(r.date, r.count));
    const series = days30.map((date) => ({ date, count: byDate.get(date) ?? 0 }));
    const views30d = series.reduce((sum, p) => sum + p.count, 0);
    const views7d = series.slice(-7).reduce((sum, p) => sum + p.count, 0);

    // Per-listing views (last 7 days) for this storefront's products.
    const myListings = await this.listings.find({ storefrontId: sId }).select('_id').lean().exec();
    const listingIds = myListings.map((l) => l._id);
    let byListing: { listingId: string; views7d: number }[] = [];
    if (listingIds.length > 0) {
      const start7 = dayList(today, 7)[0];
      const lrows = await this.daily
        .find({ targetType: 'listing', targetId: { $in: listingIds }, date: { $gte: start7 } })
        .lean()
        .exec();
      const tally = new Map<string, number>();
      lrows.forEach((r) => {
        const k = String(r.targetId);
        tally.set(k, (tally.get(k) ?? 0) + r.count);
      });
      byListing = [...tally.entries()].map(([listingId, v]) => ({ listingId, views7d: v }));
    }

    return { views7d, views30d, series, byListing };
  }

  /**
   * Owner-scoped profile-view totals for the header stat. Profile views are
   * recorded with targetType 'profile' + targetId = the viewed person's User id
   * (recorded from the public /u/[slug] page). 30d/7d come from the daily rollup;
   * `total` is the all-time sum for that profile. Cross-module: the web profile
   * header reads this via GET connect/views/profile/summary.
   */
  async profileViewSummary(ownerUserId: string): Promise<ProfileViewSummary> {
    const tId = new Types.ObjectId(ownerUserId);
    const today = new Date();
    const windowStart = dayList(today, 30)[0];
    const rows = await this.daily
      .find({ targetType: 'profile', targetId: tId, date: { $gte: windowStart } })
      .lean()
      .exec();
    const views30d = rows.reduce((s, r) => s + r.count, 0);
    const start7 = dayList(today, 7)[0];
    const views7d = rows.filter((r) => r.date >= start7).reduce((s, r) => s + r.count, 0);
    const allRows = await this.daily
      .find({ targetType: 'profile', targetId: tId })
      .select('count')
      .lean()
      .exec();
    const total = allRows.reduce((s, r) => s + r.count, 0);
    return { views7d, views30d, total };
  }
}
