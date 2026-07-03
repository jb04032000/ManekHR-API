import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MENTION_CAP } from './mention.constants';
import type { MentionType } from '../feed/schemas/mention.subschema';
import { NetworkService } from '../network/network.service';

/** The client-sent tag (picker is source of truth). href is computed here. */
export interface MentionInput {
  type: MentionType;
  refId: string;
  display: string;
}
/** Stored, link-ready tag (mirrors the Mention sub-schema). */
export interface StoredMention {
  type: MentionType;
  refId: Types.ObjectId;
  display: string;
  href: string;
}

/**
 * MentionService - validates + resolves @mentions (tags) for posts/comments and
 * enforces the "who can tag whom" gates. What it does: order-matches each tag's
 * "@<display>" token against the body, resolves the entity, applies block +
 * visibility + cap gates, computes the public href, dedupes notification
 * recipients (skipping self). Cross-module: reads User/ConnectProfile (people),
 * CompanyPage/Storefront (pages), UserBlock (blocks), NetworkService
 * (connections). Used by FeedService.createPost/editPost + CommentService.
 * Watch: href is a snapshot; render-time handles later rename/delete.
 */
@Injectable()
export class MentionService {
  constructor(
    @InjectModel('User') private readonly userModel: Model<Record<string, unknown>>,
    @InjectModel('ConnectProfile') private readonly profileModel: Model<Record<string, unknown>>,
    @InjectModel('CompanyPage') private readonly pageModel: Model<Record<string, unknown>>,
    @InjectModel('Storefront') private readonly storefrontModel: Model<Record<string, unknown>>,
    @InjectModel('UserBlock') private readonly blockModel: Model<Record<string, unknown>>,
    private readonly network: NetworkService,
  ) {}

  /**
   * Validate + resolve the tags for a write.
   *  - `actorId`     : who is tagging (drives the bidirectional block + self-skip).
   *  - `audienceOwnerId` (default = actorId): whose audience defines "can see this
   *    content" for the connections-only reach gate. On a COMMENT this MUST be the
   *    POST author, not the commenter, or a connections-only post could be tagged
   *    to (and leaked to) someone outside its audience. See comment.service.
   * The stored `display` is set from the entity's CANONICAL name (never the
   * client-sent label) and the body is order-matched against that canonical name,
   * so a client cannot render a real link under a spoofed chip label.
   * Returns the stored tags + the dedup'd notification recipients + a per-entity
   * recipient list (refId -> ownerUserId) so an edit can re-notify only NEW tags.
   */
  async resolveForWrite(
    actorId: Types.ObjectId,
    body: string,
    input: MentionInput[] | undefined,
    visibility: 'public' | 'connections',
    audienceOwnerId?: Types.ObjectId,
  ): Promise<{
    stored: StoredMention[];
    recipientUserIds: string[];
    recipients: Array<{ refId: string; ownerUserId: string }>;
  }> {
    if (!input || input.length === 0) return { stored: [], recipientUserIds: [], recipients: [] };
    if (input.length > MENTION_CAP) {
      throw new BadRequestException(`You can tag up to ${MENTION_CAP} people or pages.`);
    }

    const blocked = await this.getBlockedUserIds(actorId);
    // Reach is judged against the AUDIENCE owner's connection graph (the post
    // author for comments), not the actor's - so a commenter cannot tag someone
    // who cannot see the post.
    const audience = audienceOwnerId ?? actorId;
    const audienceStr = String(audience);
    let connectionIds: Set<string> | null = null;
    const connections = async (): Promise<Set<string>> => {
      if (!connectionIds) {
        const conns = await this.network.listConnections(audience);
        connectionIds = new Set(conns.map((c) => c.userId));
      }
      return connectionIds;
    };
    const canSee = async (ownerId: string): Promise<boolean> =>
      ownerId === audienceStr || (await connections()).has(ownerId);

    const actorStr = String(actorId);
    const stored: StoredMention[] = [];
    const recipients: Array<{ refId: string; ownerUserId: string }> = [];
    let cursor = 0;

    for (const m of input) {
      const resolved = await this.resolveOne(m);
      if (!resolved) throw new BadRequestException('A tagged account no longer exists.');
      const { ownerUserId, href, profileVisibility, name } = resolved;

      // Order-match guard against the CANONICAL name (anti-spoof): the body must
      // contain "@<canonical name>" in order, so the stored + rendered chip label
      // is always the real entity name, never a client-crafted label.
      const token = `@${name}`;
      const idx = body.indexOf(token, cursor);
      if (idx === -1) throw new BadRequestException('A tag does not match the post text.');
      cursor = idx + token.length;

      // Gate B - block (bidirectional), against the entity owner.
      if (ownerUserId && blocked.has(ownerUserId)) {
        throw new ForbiddenException('You cannot tag this account.');
      }

      // Gate C - reach / visibility.
      if (m.type === 'profile') {
        if (profileVisibility === 'hidden') {
          throw new BadRequestException('This profile cannot be tagged.');
        }
        if (visibility === 'connections') {
          if (!(await canSee(ownerUserId))) {
            throw new ForbiddenException(
              'You can only tag your connections on a connections-only post.',
            );
          }
        } else if (profileVisibility === 'connections' && !(await canSee(ownerUserId))) {
          throw new ForbiddenException('This profile cannot be tagged.');
        }
      } else if (visibility === 'connections' && ownerUserId && !(await canSee(ownerUserId))) {
        throw new ForbiddenException(
          'You can only tag pages whose owner is a connection on a connections-only post.',
        );
      }

      stored.push({ type: m.type, refId: new Types.ObjectId(m.refId), display: name, href });
      // Gate D - skip self; collect per-entity recipients (refId -> owner).
      if (ownerUserId && ownerUserId !== actorStr) {
        recipients.push({ refId: m.refId, ownerUserId });
      }
    }

    const recipientUserIds = [...new Set(recipients.map((r) => r.ownerUserId))];
    return { stored, recipientUserIds, recipients };
  }

  /** All user ids blocked in EITHER direction relative to `viewer`. */
  private async getBlockedUserIds(viewer: Types.ObjectId): Promise<Set<string>> {
    const rows = await this.blockModel
      .find({ $or: [{ blockerUserId: viewer }, { blockedUserId: viewer }] })
      .select('blockerUserId blockedUserId')
      .lean()
      .exec();
    const set = new Set<string>();
    for (const r of rows as Array<{
      blockerUserId: Types.ObjectId;
      blockedUserId: Types.ObjectId;
    }>) {
      set.add(String(r.blockerUserId.equals(viewer) ? r.blockedUserId : r.blockerUserId));
    }
    return set;
  }

  /** Resolve one tag to its owner + canonical name + public href + (people)
   *  profile visibility. `name` is the server-trusted chip label (anti-spoof). */
  private async resolveOne(m: MentionInput): Promise<{
    ownerUserId: string | null;
    href: string;
    name: string;
    profileVisibility?: string;
  } | null> {
    if (!Types.ObjectId.isValid(m.refId)) return null;
    const refId = new Types.ObjectId(m.refId);
    if (m.type === 'profile') {
      const [user, profile] = await Promise.all([
        this.userModel.findById(refId).select('handle name').lean().exec(),
        this.profileModel.findOne({ userId: refId }).select('visibility').lean().exec(),
      ]);
      if (!user || !profile) return null;
      const u = user as { handle?: string; name?: string };
      if (!u.name) return null;
      const slug = u.handle || String(refId);
      return {
        ownerUserId: String(refId),
        href: `/connect/u/${slug}`,
        name: u.name,
        profileVisibility: (profile as { visibility?: string }).visibility ?? 'public',
      };
    }
    if (m.type === 'company') {
      const page = await this.pageModel
        .findById(refId)
        .select('slug ownerUserId name')
        .lean()
        .exec();
      if (!page) return null;
      const p = page as { slug: string; ownerUserId?: Types.ObjectId; name?: string };
      if (!p.name) return null;
      return {
        ownerUserId: p.ownerUserId ? String(p.ownerUserId) : null,
        href: `/connect/company/${p.slug}`,
        name: p.name,
      };
    }
    // storefront
    const store = await this.storefrontModel
      .findById(refId)
      .select('slug ownerUserId name')
      .lean()
      .exec();
    if (!store) return null;
    const s = store as { slug: string; ownerUserId?: Types.ObjectId; name?: string };
    if (!s.name) return null;
    return {
      ownerUserId: s.ownerUserId ? String(s.ownerUserId) : null,
      href: `/connect/store/${s.slug}`,
      name: s.name,
    };
  }
}
