import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { UserBlock } from '../inbox/schemas/user-block.schema';

/**
 * SearchBlockFilterService -- the viewer-contextual block-list gate for Connect
 * search (APPROVED visibility-contract change; Wave 1 launch blocker).
 *
 * What it does: resolves the set of user ids the viewer must never see in
 * search results because a block exists in EITHER direction (the viewer blocked
 * them, OR they blocked the viewer), then drops every result authored by one of
 * those ids.
 *
 * Cross-module links:
 *   - Reads the SAME canonical block store the feed + inbox use:
 *     `connect_user_blocks` (`UserBlock` schema, owned by the inbox module).
 *     This deliberately mirrors `FeedService.getBlockedUserIds` so search and
 *     feed share one definition of "blocked" -- no second block store invented.
 *   - Consumed by `FederatedSearchService` post-Meili, pre-blend, applied to
 *     EVERY vertical's rows by author id so future verticals inherit it.
 *
 * Watch:
 *   - This is the ONLY viewer-contextual filter in the search path. It runs on
 *     server, never the client. If a new vertical is added, route its author id
 *     into `filterRows` so it is covered automatically.
 *   - Blocks are usually empty -> one cheap indexed lookup per search read
 *     (indexed on blockerUserId+blockedUserId and blockedUserId).
 */
@Injectable()
export class SearchBlockFilterService {
  constructor(
    @InjectModel(UserBlock.name)
    private readonly userBlockModel: Model<UserBlock>,
  ) {}

  /**
   * The set of user ids the viewer must not see, from a block in either
   * direction. Returns a string set so callers can match on `String(authorId)`
   * regardless of the id's runtime type (ObjectId vs string vs hydrated ref).
   */
  async getBlockedUserIds(viewerUserId: string): Promise<Set<string>> {
    const viewer = new Types.ObjectId(viewerUserId);
    const rows = await this.userBlockModel
      .find({ $or: [{ blockerUserId: viewer }, { blockedUserId: viewer }] })
      .select('blockerUserId blockedUserId')
      .lean<Array<{ blockerUserId: Types.ObjectId; blockedUserId: Types.ObjectId }>>()
      .exec();
    const set = new Set<string>();
    for (const r of rows) {
      // Add the OTHER party in each block pair (the viewer is never blocked
      // from themselves).
      set.add(String(r.blockerUserId.equals(viewer) ? r.blockedUserId : r.blockerUserId));
    }
    return set;
  }

  /**
   * Drop every row whose author id is in the blocked set. Generic over the row
   * shape: the caller supplies how to read the author id off each row (people
   * carry `userId`, listings `ownerUserId`, posts `authorId`, jobs
   * `companyUserId`). A blocked result is absent from the returned array AND,
   * because the caller derives counts from the filtered array, uncounted.
   * No-op (returns the same array) when nothing is blocked.
   */
  filterRows<T>(rows: T[], authorIdOf: (row: T) => string, blocked: ReadonlySet<string>): T[] {
    if (blocked.size === 0 || rows.length === 0) return rows;
    return rows.filter((row) => !blocked.has(String(authorIdOf(row))));
  }
}
