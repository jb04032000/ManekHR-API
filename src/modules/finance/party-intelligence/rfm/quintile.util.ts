/**
 * Phase 17 / FIN-16-01 D-02 — dynamic quintile cutoff utility.
 *
 * Two exports:
 *   - computeQuintiles(model, wsOid, firmOid, dimension): query helper that
 *     uses MongoDB $bucketAuto to derive 4 cutoffs (5 buckets) for the given
 *     numeric dimension stored on Party.intelligence.<dimension>. Ties-aware
 *     by virtue of $bucketAuto's even-distribution algorithm. Returns the
 *     `max` value of buckets 1..4 (the upper edges) — bucket 5 has no upper
 *     edge (open-ended); a value above all cutoffs gets the top score.
 *
 *   - scoreValue(value, cutoffs, invert): pure function — given a raw value
 *     and the cutoff array, returns a 1..5 integer. `invert=true` is used
 *     for recency: lower recencyDays should map to higher scores.
 *
 * Pitfall 6 (quintile collapse on tiny populations) is handled by the
 * caller (rfm-segmenter.service): when active-party count < 5, the segmenter
 * skips quintile computation entirely and applies fixed thresholds (D-06).
 *
 * Empty/insufficient population: scoreValue returns 1 when cutoffs are empty
 * or value is null/undefined (caller path won't typically hit this — but the
 * fallback is conservative). For inverted scoring, empty population still
 * returns 1.
 */

import type { Model, Types } from 'mongoose';

export type QuintileDimension = 'recencyDays' | 'frequency' | 'monetaryPaise';

/**
 * Compute 4 quintile cutoffs (max of bucket 1..4) for the given dimension
 * over all non-deleted parties in the (wsId, firmId) scope. $bucketAuto
 * splits the population into ~equal-sized buckets — ties are handled by
 * spreading equal values across buckets; the boundaries land where the
 * cumulative count crosses a quintile.
 *
 * Returns up to 4 numbers (one per cutoff). When the population is too
 * small for 5 buckets, $bucketAuto may return fewer buckets — caller should
 * already have skipped to fixed-threshold mode (< 5 parties), but we still
 * return whatever cutoffs Mongo produced.
 */
export async function computeQuintiles(
  partyModel: Model<any>,
  wsOid: Types.ObjectId,
  firmOid: Types.ObjectId | null,
  dimension: QuintileDimension,
): Promise<number[]> {
  const match: Record<string, unknown> = {
    workspaceId: wsOid,
    isDeleted: false,
  };
  if (firmOid) match.firmId = firmOid;

  const buckets = await partyModel.aggregate([
    { $match: match },
    { $project: { value: `$intelligence.${dimension}` } },
    { $match: { value: { $ne: null } } },
    { $bucketAuto: { groupBy: '$value', buckets: 5 } },
  ]);

  // $bucketAuto returns objects with shape { _id: { min, max }, count }.
  // Cutoffs = max of each bucket (the upper edge). Drop the last entry's
  // max because the 5th bucket is open-ended and we only need 4 cutoffs to
  // partition into 5 segments.
  const sorted = buckets
    .map((b: any) => Number(b?._id?.max))
    .filter((n: number) => Number.isFinite(n));
  if (sorted.length <= 1) return sorted;
  return sorted.slice(0, -1); // drop the final upper edge
}

/**
 * scoreValue — pure quintile scorer.
 *
 * Bucket assignment:
 *   bucket = 1 + count(cutoffs[i] < value)         (clamped to [1, 5])
 *   when invert=true → score = 6 - bucket          (lower value = higher score)
 *
 * `cutoffs` is the array of 4 upper-edges (bucket 1..4). A value <= cutoffs[0]
 * lands in bucket 1; a value > cutoffs[3] lands in bucket 5.
 *
 * Edge cases:
 *   - value null/undefined → 1 (or 5 when invert; conservative — but caller
 *     never passes null in practice; we err on the "low" side either way
 *     and the segmenter's fallback path handles missing data).
 *   - cutoffs empty → 1 always.
 */
export function scoreValue(
  value: number | null | undefined,
  cutoffs: number[],
  invert: boolean,
): 1 | 2 | 3 | 4 | 5 {
  if (value == null) return 1;
  if (!cutoffs || cutoffs.length === 0) return 1;

  // Find first cutoff strictly greater than value → that's our bucket index.
  // If value <= cutoffs[0] → bucket 1; if value > all → bucket 5.
  let bucket = 1;
  for (let i = 0; i < cutoffs.length; i++) {
    if (value <= cutoffs[i]) {
      bucket = i + 1;
      break;
    }
    bucket = i + 2; // overflow past this cutoff
  }
  if (bucket < 1) bucket = 1;
  if (bucket > 5) bucket = 5;

  const score = invert ? 6 - bucket : bucket;
  return score as 1 | 2 | 3 | 4 | 5;
}
