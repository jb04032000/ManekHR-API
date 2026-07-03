import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { MentionScope } from './dto/suggest.dto';

export interface MentionSuggestion {
  type: 'profile' | 'company' | 'storefront';
  id: string;
  display: string;
  href: string;
  avatar: string | null;
}

const PER_TYPE = 6;
/** Escape user text for a safe anchored, case-insensitive prefix regex. */
function prefix(q: string): RegExp {
  return new RegExp('^' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

/**
 * MentionSuggestService - backs the composer @-picker. What it does: fast,
 * compact prefix search over public people + company pages + storefronts,
 * excluding the viewer + anyone blocked either way. Returns only what a chip
 * needs. Cross-module: reads User/ConnectProfile, CompanyPage, Storefront,
 * UserBlock. Watch: keep the public filters identical to the search helpers so
 * the picker never surfaces something search would hide.
 */
@Injectable()
export class MentionSuggestService {
  constructor(
    @InjectModel('User') private readonly userModel: Model<Record<string, unknown>>,
    @InjectModel('ConnectProfile') private readonly profileModel: Model<Record<string, unknown>>,
    @InjectModel('CompanyPage') private readonly pageModel: Model<Record<string, unknown>>,
    @InjectModel('Storefront') private readonly storefrontModel: Model<Record<string, unknown>>,
    @InjectModel('UserBlock') private readonly blockModel: Model<Record<string, unknown>>,
  ) {}

  async suggest(
    viewerId: string,
    q: string,
    scope: MentionScope = 'all',
  ): Promise<MentionSuggestion[]> {
    const trimmed = q.trim();
    if (!trimmed) return [];
    const rx = prefix(trimmed);
    const blocked = await this.getBlockedUserIds(new Types.ObjectId(viewerId));
    const out: MentionSuggestion[] = [];

    if (scope === 'all' || scope === 'people') {
      const users = (await this.userModel
        .find({ $or: [{ name: rx }, { handle: rx }] })
        .select('_id name handle profilePicture')
        .limit(PER_TYPE * 3)
        .lean()
        .exec()) as Array<{
        _id: Types.ObjectId;
        name: string;
        handle?: string;
        profilePicture?: string;
      }>;
      const ids = users.map((u) => u._id);
      const publicProfiles = (await this.profileModel
        .find({ userId: { $in: ids }, visibility: 'public' })
        .select('userId')
        .lean()
        .exec()) as Array<{ userId: Types.ObjectId }>;
      const publicSet = new Set(publicProfiles.map((p) => String(p.userId)));
      let added = 0;
      for (const u of users) {
        if (added >= PER_TYPE) break;
        const id = String(u._id);
        if (id === viewerId || blocked.has(id) || !publicSet.has(id)) continue;
        out.push({
          type: 'profile',
          id,
          display: u.name,
          href: `/connect/u/${u.handle || id}`,
          avatar: u.profilePicture ?? null,
        });
        added += 1;
      }
    }
    if (scope === 'all' || scope === 'companies') {
      const pages = (await this.pageModel
        .find({ name: rx, visibility: 'public' })
        .select('_id name slug logo')
        .limit(PER_TYPE)
        .lean()
        .exec()) as Array<{ _id: Types.ObjectId; name: string; slug: string; logo?: string }>;
      for (const p of pages) {
        out.push({
          type: 'company',
          id: String(p._id),
          display: p.name,
          href: `/connect/company/${p.slug}`,
          avatar: p.logo ?? null,
        });
      }
    }
    if (scope === 'all' || scope === 'storefronts') {
      const stores = (await this.storefrontModel
        .find({ name: rx, visibility: 'public' })
        .select('_id name slug logo')
        .limit(PER_TYPE)
        .lean()
        .exec()) as Array<{ _id: Types.ObjectId; name: string; slug: string; logo?: string }>;
      for (const s of stores) {
        out.push({
          type: 'storefront',
          id: String(s._id),
          display: s.name,
          href: `/connect/store/${s.slug}`,
          avatar: s.logo ?? null,
        });
      }
    }
    return out;
  }

  private async getBlockedUserIds(viewer: Types.ObjectId): Promise<Set<string>> {
    const rows = (await this.blockModel
      .find({ $or: [{ blockerUserId: viewer }, { blockedUserId: viewer }] })
      .select('blockerUserId blockedUserId')
      .lean()
      .exec()) as Array<{ blockerUserId: Types.ObjectId; blockedUserId: Types.ObjectId }>;
    const set = new Set<string>();
    for (const r of rows)
      set.add(String(r.blockerUserId.equals(viewer) ? r.blockedUserId : r.blockerUserId));
    return set;
  }
}
