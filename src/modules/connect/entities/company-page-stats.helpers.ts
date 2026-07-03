/**
 * Pure assembly for the Company Pages hub stats. The service runs three grouped
 * aggregations (followers / posts-30d / open-jobs) keyed by page id; this stitches
 * those count maps onto the owner's page list and rolls up the KPI totals. Kept
 * Mongoose-free so it unit-tests without a DB.
 */

export interface CompanyPageStat {
  pageId: string;
  slug: string;
  name: string;
  logo: string;
  followers: number;
  /** Posts published as this page in the last 30 days. */
  posts: number;
  openJobs: number;
}

export interface CompanyPageStatsResult {
  pages: CompanyPageStat[];
  totals: { pages: number; followers: number; posts: number; openJobs: number };
}

interface PageLike {
  _id: unknown;
  slug: string;
  name: string;
  logo: string;
}

type CountMap = Map<string, number>;

/** Stitch the per-page count maps onto the page list and compute KPI totals. */
export function assembleCompanyPageStats(
  pages: PageLike[],
  followers: CountMap,
  posts: CountMap,
  openJobs: CountMap,
): CompanyPageStatsResult {
  const stats: CompanyPageStat[] = pages.map((p) => {
    const id = String(p._id);
    return {
      pageId: id,
      slug: p.slug,
      name: p.name,
      logo: p.logo,
      followers: followers.get(id) ?? 0,
      posts: posts.get(id) ?? 0,
      openJobs: openJobs.get(id) ?? 0,
    };
  });

  const totals = stats.reduce(
    (acc, s) => ({
      pages: acc.pages + 1,
      followers: acc.followers + s.followers,
      posts: acc.posts + s.posts,
      openJobs: acc.openJobs + s.openJobs,
    }),
    { pages: 0, followers: 0, posts: 0, openJobs: 0 },
  );

  return { pages: stats, totals };
}
