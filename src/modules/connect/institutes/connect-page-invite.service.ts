import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as crypto from 'crypto';
import * as Sentry from '@sentry/nestjs';
import {
  ConnectPageInvite,
  type ConnectPageInviteDocument,
  CONNECT_PAGE_INVITE_TTL_DAYS,
} from './schemas/connect-page-invite.schema';
import { User } from '../../users/schemas/user.schema';
import { CompanyPageService } from '../entities/services/company-page.service';
import { AuditService } from '../../audit/audit.service';
import { AppModule } from '../../../common/enums/modules.enum';
import { PostHogService } from '../../../common/posthog/posthog.service';
import { normaliseIndianMobile } from '../../auth/utils/mobile-normalizer';

/** Hard cap on how many phones one bulk-invite call may process. Mirrors the
 *  controller DTO `@ArrayMaxSize`; enforced again here so a non-HTTP caller can
 *  never blow past it. */
export const BULK_INVITE_MAX = 200;

/** One created invite, returned to the page owner so the FE can build a wa.me
 *  share link. The raw `token` is surfaced ONCE here and never persisted (only its
 *  sha256 hash lives on the row). */
export interface BulkInviteCreated {
  /** Canonical 12-digit mobile (`91XXXXXXXXXX`). */
  mobile: string;
  /** Raw shareable token (the FE embeds it in the invite link). */
  token: string;
}

/** Result of a bulk-invite run. `created` + `skipped` are counts; `invites`
 *  carries the per-row tokens for the FE. `invalid` counts numbers that could not
 *  be parsed as an Indian mobile (reported, never errored). */
export interface BulkInviteResult {
  created: number;
  skipped: number;
  invalid: number;
  invites: BulkInviteCreated[];
}

/** Page-owner-scoped invite metrics. Both counts are filtered by the caller's OWN
 *  pageId only (no cross-institute id is ever queryable from this surface). */
export interface PageInviteSummary {
  /** Users whose first-touch referral source is THIS page. */
  joinedCount: number;
  /** Outstanding `invited` (un-claimed) rows for THIS page. */
  pendingCount: number;
}

/**
 * ManekHR Connect -- `ConnectPageInviteService` (Institutes Phase 2, Feature 5:
 * bulk student invite + first-touch referral attribution).
 *
 * What this does: lets an institute (page owner) bulk-invite a list of student
 * phone numbers, and reports the page's invite/referral metrics. Inviting writes
 * one `ConnectPageInvite` row per never-before-pending mobile (minting a random
 * shareable token, persisting only its hash) and returns the raw tokens so the FE
 * can build wa.me share links. Attribution itself is NOT done here: it runs later,
 * event-driven, in InstituteReferralService when an invited mobile first onboards
 * into Connect (first-touch: the earliest matching invite wins).
 *
 * Security / privacy:
 *  - Every method is page-owner gated via `CompanyPageService.getMine` (404 for a
 *    non-owner; no existence leak). The page owner can only act on / read their OWN
 *    page's invites + metrics.
 *  - `summary` filters strictly by the caller's own `pageId`. No other institute's
 *    id is accepted or queryable from this surface, so one institute can never read
 *    another's joined / pending counts (DPDP / cross-tenant metric-leak guard).
 *
 * Resilience: bulkInvite uses per-row try/catch (inviteMember-style) so one bad
 * number never fails the whole batch (partial success). The dedupe skip ("an
 * `invited` non-expired row already exists for this page+mobile") is reported as
 * `skipped`, not an error.
 *
 * Cross-module links:
 *  - CompanyPageService (Connect entities) -> the page-owner gate (`getMine`).
 *  - `normaliseIndianMobile` (auth utils) -> canonical `91XXXXXXXXXX` form so the
 *    stored `inviteeMobile` exactly equals `User.mobile` for later attribution.
 *  - `ConnectPageInvite` (this module) + `User.invitedByCompanyPageId` (the
 *    first-touch stamp that drives `joinedCount`). The User model token is
 *    registered schema-only on this module's `forFeature` for the count.
 *  - AuditService / PostHogService -> the bulk-invite write seam.
 *
 * Keep in sync with: the ConnectPageInvite schema (status enum + TTL), the
 * `StudentInvitesController` route shapes, the `BulkInviteDto` `@ArrayMaxSize`,
 * and InstituteReferralService (which claims these rows).
 */
@Injectable()
export class ConnectPageInviteService {
  private readonly logger = new Logger(ConnectPageInviteService.name);

  constructor(
    @InjectModel(ConnectPageInvite.name)
    private readonly inviteModel: Model<ConnectPageInviteDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    private readonly companyPages: CompanyPageService,
    private readonly audit: AuditService,
    @Optional() @Inject(PostHogService) private readonly posthog?: PostHogService,
  ) {}

  /**
   * Bulk-invite a list of student phone numbers from the given page (page-owner
   * gated). Normalises + de-dupes the batch, skips numbers that already have a
   * pending non-expired invite for this page, and creates a row (with a minted
   * token) for the rest. Returns counts plus the raw per-row tokens so the FE can
   * build wa.me share links. Per-row try/catch keeps one bad write from failing
   * the batch (partial success).
   */
  async bulkInvite(
    pageOwnerUserId: string,
    pageId: string,
    phones: string[],
  ): Promise<BulkInviteResult> {
    // Page-owner gate. Throws NotFoundException for a non-owner / missing page (no
    // existence leak) BEFORE any invite work runs.
    const page = await this.companyPages.getMine(pageOwnerUserId, pageId);
    const pageObjectId = page._id;
    const ownerObjectId = new Types.ObjectId(pageOwnerUserId);

    // Normalise to the canonical 12-digit form + de-dupe within the batch. An
    // unparseable number is counted as `invalid` and dropped (never errors). Cap
    // the batch defensively even if a non-HTTP caller bypassed the DTO.
    const capped = (phones ?? []).slice(0, BULK_INVITE_MAX);
    const seen = new Set<string>();
    let invalid = 0;
    const normalised: string[] = [];
    for (const raw of capped) {
      const norm = normaliseIndianMobile(typeof raw === 'string' ? raw : '');
      if (!norm) {
        invalid += 1;
        continue;
      }
      if (seen.has(norm.full)) continue; // intra-batch dedupe.
      seen.add(norm.full);
      normalised.push(norm.full);
    }

    const now = Date.now();
    const expiry = new Date(now + CONNECT_PAGE_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

    let created = 0;
    let skipped = 0;
    const invites: BulkInviteCreated[] = [];

    for (const mobile of normalised) {
      try {
        // Skip if THIS page already has a pending (un-claimed) AND non-expired
        // invite for this mobile. Reported as `skipped`, not an error. The
        // `inviteExpiry > now` clause matches the spec ("`invited` AND non-expired")
        // and keeps this dedupe consistent with the attribution handler
        // (institute-referral.service.ts), which only treats non-expired `invited`
        // rows as claim winners. No expiry-sweep cron exists yet, so an `invited`
        // row can be logically expired before a sweep flips its status; without this
        // clause such a stale row would silently block a legitimate re-invite (and
        // the attribution path would ignore it as a winner, leaving the re-invited
        // student unattributed). Excluding expired rows here therefore lets a fresh
        // re-invite through and keeps the dedupe path and the attribution path in step.
        const existing = await this.inviteModel
          .findOne({
            companyPageId: pageObjectId,
            inviteeMobile: mobile,
            status: 'invited',
            inviteExpiry: { $gt: new Date(now) },
          })
          .select('_id')
          .lean<{ _id: Types.ObjectId } | null>()
          .exec();
        if (existing) {
          skipped += 1;
          continue;
        }

        // Mint a 256-bit raw token; persist only its sha256 hash (the raw token is
        // returned once for the share link, never stored). Mirrors the auth
        // invite-token hashing pattern.
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

        await this.inviteModel.create({
          companyPageId: pageObjectId,
          createdByUserId: ownerObjectId,
          inviteeMobile: mobile,
          tokenHash,
          inviteExpiry: expiry,
          status: 'invited',
        });

        created += 1;
        invites.push({ mobile, token: rawToken });
      } catch (err) {
        // Partial success: a single-row fault (e.g. a write race) is logged +
        // captured but never fails the batch. The number is neither created nor
        // skipped; it simply does not appear in `invites` (the FE re-invites if
        // needed). Mirrors the inviteMember-style per-row try/catch.
        this.logger.warn(
          `bulk invite row failed for page ${pageId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        Sentry.captureException(err, {
          tags: { module: 'connect.page_invite', op: 'bulkInvite.row' },
        });
      }
    }

    // Audit + analytics on the batch (counts only; never the raw numbers / tokens).
    await this.audit.logEvent({
      module: AppModule.CONNECT,
      entityType: 'ConnectPageInvite',
      entityId: String(pageObjectId),
      action: 'connect_page_invite_bulk',
      actorId: pageOwnerUserId,
      meta: { pageId, created, skipped, invalid, requested: capped.length },
    });
    this.posthog?.capture({
      distinctId: pageOwnerUserId,
      event: 'connect.page_invite_bulk',
      properties: { pageId, created, skipped, invalid, requested: capped.length },
    });

    return { created, skipped, invalid, invites };
  }

  /**
   * Page-owner-scoped invite metrics (page-owner gated). `joinedCount` = users
   * whose first-touch referral source is THIS page; `pendingCount` = outstanding
   * `invited` rows for THIS page. Both filters use the caller's OWN pageId only,
   * so no cross-institute count is ever reachable.
   */
  async summary(pageOwnerUserId: string, pageId: string): Promise<PageInviteSummary> {
    const page = await this.companyPages.getMine(pageOwnerUserId, pageId);
    const pageObjectId = page._id;

    const [joinedCount, pendingCount] = await Promise.all([
      // Strictly scoped to THIS page's id (PII / cross-institute metric-leak guard).
      this.userModel.countDocuments({ invitedByCompanyPageId: pageObjectId }),
      this.inviteModel.countDocuments({ companyPageId: pageObjectId, status: 'invited' }),
    ]);

    return { joinedCount, pendingCount };
  }
}
