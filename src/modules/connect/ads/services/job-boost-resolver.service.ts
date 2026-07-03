import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AdCampaign, type AdCampaignDocument } from '../schemas/ad-campaign.schema';

/**
 * Read-only resolver for the jobs board's "Promoted" block (Phase 5.1).
 *
 * Returns the jobRefs of the currently-active job-boost campaigns so the jobs
 * module can pin them above the organic stream. This is DELIBERATELY separate
 * from AdDecisionService.decide():
 *   - decide() is single-winner, runs targeting/pacing/freq-cap, and OPENS an
 *     impression record (it BILLS per call). We must NOT bill just to render a
 *     labelled list, and we want up to K winners, not one.
 *   - This resolver is READ-ONLY: NO impression write, NO wallet debit, NO decide.
 *     It never mutates anything. Impression/click billing for promoted jobs (if
 *     ever wired) belongs on a separate beacon path, not on this read.
 *
 * Cross-module: consumed by JobsService.listPromotedForBoard (jobs module imports
 * AdsModule and injects this service). The jobs module is responsible for loading
 * the Job docs, dropping non-`open` jobs, and applying the active board filter.
 * This resolver only answers "which jobRefs are actively boosted right now".
 *
 * Eligibility mirrors CandidateRepoMongo.top exactly so the promoted block and the
 * auction agree on what "active" means:
 *   - AdCampaign: kind 'boost_job', status 'active', startAt <= now < endAt,
 *     budgetSpent < totalBudget (budget not exhausted).
 *   - AdCreative: kind 'promoted_job', reviewStatus 'approved' (only approved
 *     creatives serve), with a non-null jobRef.
 *
 * Gotcha: keep the active-window + budget + approved-creative predicates in sync
 * with CandidateRepoMongo.top (ad-repos.ts); if that auction gate changes, this
 * read should change with it or the two surfaces will disagree.
 */
@Injectable()
export class JobBoostResolverService {
  constructor(
    @InjectModel(AdCampaign.name)
    private readonly campaignModel: Model<AdCampaignDocument>,
  ) {}

  /**
   * Resolve up to `limit` distinct jobRefs for currently-active job boosts.
   * Read-only: never opens an impression, never debits the wallet, never calls
   * decide. Returns `{ jobId }[]` in a stable (campaign newest-first) order.
   */
  async resolveActiveJobBoosts(limit: number): Promise<{ jobId: string }[]> {
    const cap = Math.max(0, Math.floor(limit));
    if (cap === 0) return [];

    const now = new Date();

    // One aggregation from the campaign side: match active boost-job campaigns
    // (window + budget), join their approved promoted_job creatives, then project
    // the distinct jobRef. $lookup with a pipeline keeps the creative predicate
    // (kind + reviewStatus + non-null jobRef) on the DB rather than in JS.
    const rows: Array<{ _id: unknown }> = await this.campaignModel.aggregate([
      {
        $match: {
          kind: 'boost_job',
          status: 'active',
          startAt: { $lte: now },
          endAt: { $gt: now },
          // Budget not exhausted: spent strictly below the allocated total.
          $expr: { $lt: ['$budgetSpent', '$totalBudget'] },
        },
      },
      // Newest campaign first, so the promoted order is deterministic.
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: 'ad_creatives',
          let: { cid: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$campaignId', '$$cid'] },
                kind: 'promoted_job',
                reviewStatus: 'approved',
                jobRef: { $ne: null },
              },
            },
            { $project: { _id: 0, jobRef: 1 } },
          ],
          as: 'creative',
        },
      },
      // Drop campaigns whose creative is missing / unapproved.
      { $unwind: '$creative' },
      // Distinct jobRef, preserving the newest-campaign-first order ($first wins).
      { $group: { _id: '$creative.jobRef', order: { $first: '$createdAt' } } },
      { $sort: { order: -1 } },
      { $limit: cap },
      { $project: { _id: 1 } },
    ]);

    return rows.filter((r) => r._id != null).map((r) => ({ jobId: String(r._id) }));
  }
}
