/**
 * Connect content-purge MANIFEST (ACCOUNT-DELETION-AND-DPDP-PLAN.md §3A / §A.12).
 *
 * One entry per `connect_*` collection. This is the SINGLE SOURCE OF TRUTH that
 * drives {@link ConnectContentPurgeService}: what each collection holds, whose
 * data it is, and the §3A action class that decides whether the deleting user's
 * rows are hard-deleted, the row is retained with the FK nulled, an embedded
 * element is pulled, a counterpart aggregate is recomputed, or the row is
 * retained intact as third-party/billing evidence.
 *
 * A schema-verified manifest (not a hand list) is a hard requirement of the plan
 * (§A.12): `connect-purge-manifest.vitest.ts` FAILS THE BUILD if any collection
 * declared by a `@Schema({ collection })` under `src/modules/connect` is missing
 * here, and a positive leak test asserts no document resolves to an erased
 * identity after the purge runs.
 *
 * ACTION CLASSES (plan §3A):
 *  - (a)  `own`           hard-delete rows keyed by this user (self-contained own content)
 *  - (b-out) `outbound`   hard-delete outbound rows referencing this user (the counterpart
 *                         loses a lead they no longer need; nothing is orphaned)
 *  - (b-out) `pull-embedded` pull the array element the user AUTHORED from OTHER docs
 *  - (b-about) `evidence` retain third-party evidence about the user, intact
 *  - (b-msg) `null-fk`    retain the shared row; null the (nullable) user FK(s)
 *  - (c)  `recompute`     hard-delete the user's contributing rows AND recompute the
 *                         counterpart's denormalized aggregate (reuses the owning service)
 *  - (d)  `billing`       retain money / credit / fraud evidence (never individually purge)
 *  - (e)  `config`        platform config / no user FK — untouched (may pull the user from
 *                         an admin-campaign array)
 *  - (f)  `deindex`       handled inline via `deindexAfter` on a delete entry (Meili)
 *
 * The COLLECTION name is the authoritative key (it is what the engine touches via
 * the raw Mongoose connection); `model` is the Mongoose model name, informational
 * + used by the bespoke recompute handlers.
 */

/** The §3A action classes. The completeness gate asserts every entry uses one. */
export const CONNECT_PURGE_CLASSES = [
  'own',
  'outbound',
  'pull-embedded',
  'evidence',
  'null-fk',
  'recompute',
  'billing',
  'config',
  'deindex',
] as const;
export type ConnectPurgeClass = (typeof CONNECT_PURGE_CLASSES)[number];

/**
 * Bespoke counterpart-aggregate / cascade handlers (§3A class `c` + `f`). Each
 * names a method on {@link ConnectContentPurgeService} that owns the cascade,
 * reusing the relevant module service's encapsulated recompute. The engine calls
 * the handler INSTEAD of a generic delete (the handler captures the affected
 * counterparts, deletes the user's rows, then recomputes).
 */
export const CONNECT_PURGE_HANDLERS = [
  'feed-posts', // reuse the FeedService deletePost cascade + hard delete + child cleanup + de-index
  'feed-reactions', // delete the user's reactions, decrement each counterpart Post.reactionCount
  'feed-comments', // delete the user's comments, decrement each counterpart Post.commentCount
  'rfq-quotes', // delete the seller's quotes, recompute each counterpart Rfq aggregate
  'job-applications', // delete the applicant's applications, decrement each counterpart Job.applicationsCount
  'job-views', // delete the viewer's job-views, decrement each counterpart Job.views
  'reviews', // delete the reviewer's reviews, recompute each reviewed subject's SellerRating
  'broker-reviews', // delete the reviewer's broker reviews, recompute each broker's BrokerRating
  'views-seen', // delete the user's view markers, decrement each counterpart's ConnectViewDaily count
  'ads-purge', // CN-PURGE-1: stop the user's in-flight boost campaigns + FORFEIT unspent reserve (retain the rows)
  'rfq-orphans', // CN-PURGE-3: hard-delete the user's RFQs + cascade-delete OTHERS' quotes/rollups on them
  'job-orphans', // CN-PURGE-3: hard-delete the user's jobs + cascade-delete OTHERS' applications/saves on them
] as const;
export type ConnectPurgeHandler = (typeof CONNECT_PURGE_HANDLERS)[number];

/** After a delete, signal the search indexer to drop the now-gone entities (§3A.f). */
export type ConnectPurgeDeindex = 'listing' | 'job' | 'profile' | 'company-page' | 'storefront';

/**
 * One user-reference field the engine matches on. Most are a plain ObjectId FK;
 * a few are array-valued or polymorphic (a generic id that only references a User
 * when a sibling discriminator has a given value — those MUST NOT be matched
 * unconditionally or the purge would delete unrelated rows).
 */
export interface ConnectUserFieldMatch {
  /** Document field holding (or containing) the User reference. */
  field: string;
  /** The field is an array of user ids — match with array-contains. */
  isArray?: boolean;
  /** Only a User reference when `sibling.field === sibling.equals` (polymorphic id). */
  whenSibling?: { field: string; equals: string };
}

/** One manifest row. */
export interface ConnectPurgeEntry {
  /** Mongo collection name (authoritative key; matches the `@Schema` collection). */
  collection: string;
  /** Mongoose model name. */
  model: string;
  /** §3A action class. */
  klass: ConnectPurgeClass;
  /** What it stores + whose data it is. */
  description: string;
  /** Hard-delete a row when ANY of these resolve to the user (own/outbound). */
  deleteWhereUser?: ConnectUserFieldMatch[];
  /** Set these scalar fields to null where they equal the user (null-fk; retain row). */
  nullUserFields?: string[];
  /** $pull the user id out of these array fields, across every doc (null-fk / config). */
  pullUserFromArrays?: string[];
  /** $pull the embedded element the user authored from OTHER docs (pull-embedded). */
  pullEmbedded?: { arrayPath: string; userSubField: string };
  /** Bespoke counterpart-aggregate cascade (recompute). */
  handler?: ConnectPurgeHandler;
  /** Signal the search indexer to de-index after the delete (own/deindex). */
  deindexAfter?: ConnectPurgeDeindex;
  /** Why a retained collection keeps user-linked data (evidence/billing/config). */
  retainReason?: string;
}

/**
 * The manifest. Grouped by Connect sub-module for readability. Every row is
 * justified against the §3A table; the per-collection facts (FK nullability,
 * unique-index membership, identity snapshots) were verified against each
 * `*.schema.ts` before classification.
 */
export const CONNECT_PURGE_MANIFEST: ConnectPurgeEntry[] = [
  // ── feed ──────────────────────────────────────────────────────────────────
  {
    collection: 'connectposts',
    model: 'Post',
    klass: 'recompute',
    description:
      "The user's own feed posts. Hard-delete + the FeedService deletePost cascade. Also pulls the user's @mention chip out of OTHERS' surviving posts (CN-PURGE-2; literal @name text kept per OQ-5).",
    handler: 'feed-posts',
  },
  {
    collection: 'connectcomments',
    model: 'Comment',
    klass: 'recompute',
    description:
      "The user's own comments. Delete + decrement each counterpart Post.commentCount. Also pulls the user's @mention chip out of OTHERS' surviving comments (CN-PURGE-2).",
    handler: 'feed-comments',
  },
  {
    collection: 'connectreactions',
    model: 'Reaction',
    klass: 'recompute',
    description:
      "The user's reactions on others' posts (b-out). Delete + decrement Post.reactionCount.",
    handler: 'feed-reactions',
  },
  {
    collection: 'connectsavedposts',
    model: 'SavedPost',
    klass: 'own',
    description: "The user's private post bookmarks.",
    deleteWhereUser: [{ field: 'userId' }],
  },
  {
    collection: 'connectseenposts',
    model: 'SeenPost',
    klass: 'own',
    description: "The user's viewport-impression markers (TTL).",
    deleteWhereUser: [{ field: 'viewerId' }],
  },
  {
    collection: 'connectengagementedges',
    model: 'EngagementEdge',
    klass: 'own',
    description: "The user's engagement edges (as actor) + edges on the user's own posts.",
    deleteWhereUser: [{ field: 'actorId' }, { field: 'authorId' }],
  },
  {
    collection: 'connectfeedentries',
    model: 'FeedEntry',
    klass: 'own',
    description: "The user's fanned-out feed rows (as owner) + their posts in others' feeds.",
    deleteWhereUser: [{ field: 'ownerId' }, { field: 'authorId' }],
  },
  {
    collection: 'connect_trending',
    model: 'TrendingPost',
    klass: 'own',
    description: 'Derived trending rows authored by the user (recomputed by cron; cleaned here).',
    deleteWhereUser: [{ field: 'authorId' }],
  },
  {
    collection: 'connectfeednegativesignals',
    model: 'FeedNegativeSignal',
    klass: 'own',
    description: "The user's 'show me less' signals + signals other users aimed at the user.",
    deleteWhereUser: [{ field: 'viewerId' }, { field: 'targetId' }],
  },

  // ── inbox ─────────────────────────────────────────────────────────────────
  {
    collection: 'connect_messages',
    model: 'Message',
    klass: 'null-fk',
    description:
      'Shared conversation messages (b-msg). Retain the thread record; null the one nullable FK.',
    nullUserFields: ['senderUserId'],
    pullUserFromArrays: ['seenBy'],
  },
  {
    collection: 'connect_threads',
    model: 'Thread',
    klass: 'evidence',
    description:
      'Shared 1:1 conversation envelopes (b-msg). Retain like a sent email; the user resolves to the Deleted-user stub after the identity scrub.',
    retainReason:
      'shared multi-party conversation (participantIds + unique pairKey cannot be nulled); retained as the counterpart record per §3A(b-msg)',
  },
  {
    collection: 'connect_message_reports',
    model: 'InboxReport',
    klass: 'evidence',
    description: 'Abuse reports (moderation queue). Third-party evidence about / by the user.',
    retainReason: 'moderation / safety evidence per §3A(b-about); needed for the abuse audit trail',
  },
  {
    // Pre-existing gap surfaced by the feed-harden pass (the content-reports
    // module shipped without a manifest row). Public UGC abuse reports (posts /
    // comments / profiles / listings) — the exact analog of connect_message_reports
    // for public content. Retained as moderation evidence; the reporter/target/
    // reviewer FKs resolve to the Deleted-user stub after the identity scrub.
    collection: 'connect_content_reports',
    model: 'ContentReport',
    klass: 'evidence',
    description:
      'Public UGC abuse reports (post/comment/profile/listing) feeding the admin moderation queue. Evidence about / by the user.',
    retainReason:
      'moderation / safety evidence per §3A(b-about); needed for the abuse + AdSense UGC audit trail (mirrors connect_message_reports)',
  },
  {
    collection: 'connect_user_blocks',
    model: 'UserBlock',
    klass: 'outbound',
    description: "The user's blocks of others + others' blocks of the user (both now moot).",
    deleteWhereUser: [{ field: 'blockerUserId' }, { field: 'blockedUserId' }],
  },

  // ── network ───────────────────────────────────────────────────────────────
  {
    collection: 'connectconnectionrequests',
    model: 'ConnectionRequest',
    klass: 'outbound',
    description: 'Connection requests the user sent or received.',
    deleteWhereUser: [{ field: 'fromUserId' }, { field: 'toUserId' }],
  },
  {
    collection: 'connectconnections',
    model: 'Connection',
    klass: 'outbound',
    description: "The user's accepted connection edges (symmetric graph).",
    deleteWhereUser: [{ field: 'userA' }, { field: 'userB' }],
  },
  {
    collection: 'connectfollows',
    model: 'Follow',
    klass: 'outbound',
    description: 'Follows by the user + user-target follows of the user.',
    deleteWhereUser: [
      { field: 'followerId' },
      { field: 'followeeId', whenSibling: { field: 'followeeType', equals: 'user' } },
    ],
  },

  // ── reviews ───────────────────────────────────────────────────────────────
  {
    collection: 'connect_reviews',
    model: 'Review',
    klass: 'recompute',
    description:
      "Reviews the user WROTE about other sellers (b-out). Delete + recompute each subject's SellerRating. Reviews ABOUT the user are retained (b-about).",
    handler: 'reviews',
  },
  {
    collection: 'connect_seller_ratings',
    model: 'SellerRating',
    klass: 'evidence',
    description:
      "Denormalized seller-rating aggregate. Subjects the user reviewed are recomputed via the reviews handler; the user's own inbound aggregate is retained with its (retained) reviews.",
    retainReason:
      'derived aggregate over RETAINED third-party reviews (b-about); recomputed for affected subjects by the reviews handler, not deleted here',
  },

  // ── broker-reviews ──────────────────────────────────────────────────────────
  {
    collection: 'connect_broker_reviews',
    model: 'BrokerReview',
    klass: 'recompute',
    description:
      "Broker reviews the user WROTE (b-out). Delete + recompute each broker's BrokerRating. Reviews ABOUT the user as broker are retained (anonymous third-party).",
    handler: 'broker-reviews',
  },
  {
    collection: 'connect_broker_ratings',
    model: 'BrokerRating',
    klass: 'evidence',
    description:
      "Denormalized broker-rating aggregate. Brokers the user reviewed are recomputed via the broker-reviews handler; the user's own inbound aggregate is retained.",
    retainReason:
      'derived aggregate over RETAINED anonymous third-party reviews (b-about); recomputed for affected brokers by the broker-reviews handler, not deleted here',
  },

  // ── marketplace ─────────────────────────────────────────────────────────────
  {
    collection: 'connect_listings',
    model: 'Listing',
    klass: 'own',
    description: "The user's own marketplace listings.",
    deleteWhereUser: [{ field: 'ownerUserId' }],
    deindexAfter: 'listing',
  },
  {
    collection: 'connect_collections',
    model: 'Collection',
    klass: 'own',
    description: "The user's own storefront product collections.",
    deleteWhereUser: [{ field: 'ownerUserId' }],
  },
  {
    collection: 'connect_inquiries',
    model: 'Inquiry',
    klass: 'outbound',
    description: 'Inquiries the user sent as buyer + received as seller (now moot).',
    deleteWhereUser: [{ field: 'buyerUserId' }, { field: 'sellerUserId' }],
  },

  // ── rfq ─────────────────────────────────────────────────────────────────────
  {
    collection: 'connect_rfqs',
    model: 'Rfq',
    klass: 'recompute',
    description:
      "The user's own request-for-quote posts. Hard-delete + cascade-delete OTHERS' quotes + view-daily rollups left orphaned by the buyer's gone RFQ (CN-PURGE-3).",
    // CN-PURGE-3: the handler owns the own-delete AND the third-party cascade in
    // one pass (mirrors feed-posts). Not a plain deleteWhereUser, which would
    // leave others' quotes/rollups dangling on the now-gone RFQ.
    handler: 'rfq-orphans',
  },
  {
    collection: 'connect_quotes',
    model: 'Quote',
    klass: 'recompute',
    description:
      'Quotes the user sent as seller (b-out). Delete + recompute each counterpart Rfq aggregate.',
    handler: 'rfq-quotes',
  },

  // ── jobs ────────────────────────────────────────────────────────────────────
  {
    collection: 'connect_jobs',
    model: 'Job',
    klass: 'recompute',
    description:
      "The user's own job posts. Hard-delete + de-index + cascade-delete OTHERS' applications + saved-job rows left orphaned by the company's gone job (CN-PURGE-3).",
    // CN-PURGE-3: the handler owns the own-delete, the de-index emit, AND the
    // third-party cascade in one pass (mirrors feed-posts). Was a plain
    // deleteWhereUser+deindexAfter, which left others' applications/saves dangling.
    handler: 'job-orphans',
  },
  {
    collection: 'connect_job_applications',
    model: 'JobApplication',
    klass: 'recompute',
    description:
      'Applications the user sent (b-out). Delete + decrement each counterpart Job.applicationsCount.',
    handler: 'job-applications',
  },
  {
    collection: 'connect_job_views',
    model: 'JobView',
    klass: 'recompute',
    description: "The user's job-view markers. Delete + decrement each counterpart Job.views.",
    handler: 'job-views',
  },
  {
    collection: 'connect_saved_jobs',
    model: 'SavedJob',
    klass: 'own',
    description: "The user's private job bookmarks.",
    deleteWhereUser: [{ field: 'userId' }],
  },

  // ── institutes ──────────────────────────────────────────────────────────────
  {
    collection: 'connect_candidate_requests',
    model: 'CandidateRequest',
    klass: 'outbound',
    description: 'Hiring leads the user sent to institutes + received as institute owner.',
    deleteWhereUser: [{ field: 'fromUserId' }, { field: 'instituteOwnerUserId' }],
  },
  {
    collection: 'connect_page_invites',
    model: 'ConnectPageInvite',
    klass: 'outbound',
    description:
      "Student invites the user sent + invites that snapshot the user's mobile (claimed by the user).",
    deleteWhereUser: [{ field: 'createdByUserId' }, { field: 'claimedUserId' }],
  },

  // ── introductions ───────────────────────────────────────────────────────────
  {
    collection: 'connect_introductions',
    model: 'Introduction',
    klass: 'outbound',
    description: 'Introductions made by the user (as broker) or involving the user (b-out).',
    deleteWhereUser: [{ field: 'brokerUserId' }, { field: 'userLow' }, { field: 'userHigh' }],
  },

  // ── profile ─────────────────────────────────────────────────────────────────
  {
    collection: 'connectprofiles',
    model: 'ConnectProfile',
    klass: 'own',
    description:
      "The user's own Connect profile + recommendations the user WROTE on OTHER profiles (b-out).",
    deleteWhereUser: [{ field: 'userId' }],
    pullEmbedded: { arrayPath: 'recommendations', userSubField: 'fromUserId' },
    deindexAfter: 'profile',
  },

  // ── tags ────────────────────────────────────────────────────────────────────
  {
    collection: 'connecttags',
    model: 'ConnectTag',
    klass: 'config',
    description: 'Platform-wide hashtag taxonomy (no user FK; usageCount is a global stat).',
    retainReason: 'platform config with no user FK per §3A(e)',
  },

  // ── views ───────────────────────────────────────────────────────────────────
  {
    collection: 'connect_view_seen',
    model: 'ConnectViewSeen',
    klass: 'recompute',
    description:
      "The user's per-day view markers (TTL). Delete + decrement each viewed target's ConnectViewDaily count; inbound rows targeting the user are deleted too.",
    handler: 'views-seen',
  },
  {
    collection: 'connect_view_daily',
    model: 'ConnectViewDaily',
    klass: 'own',
    description: "The user's own inbound profile-view rollups (target = the user's profile).",
    deleteWhereUser: [
      { field: 'targetId', whenSibling: { field: 'targetType', equals: 'profile' } },
    ],
  },

  // ── promotions ──────────────────────────────────────────────────────────────
  {
    collection: 'connect_credit_drops',
    model: 'ConnectCreditDrop',
    klass: 'billing',
    description:
      'Admin promotional credit-drop campaigns. Retain the record; pull the user from the recipient array (§3A.e).',
    pullUserFromArrays: ['targetUserIds'],
    retainReason: 'admin-campaign credit evidence; createdBy is the admin actor, not the user',
  },

  // ── referrals ───────────────────────────────────────────────────────────────
  {
    collection: 'connect_referrals',
    model: 'ConnectReferral',
    klass: 'billing',
    description: 'Referral provenance (credit basis + fraud snapshots). Retain (Bucket-B/D).',
    retainReason:
      'referral credit basis + anti-fraud snapshots per §3A(d); identity snapshots are de-identified at the statutory window (Phase 7 go-live gate), never on the Connect purge',
  },
  {
    collection: 'connect_referral_configs',
    model: 'ConnectReferralConfig',
    klass: 'config',
    description: 'Platform-wide referral-program config singleton (no user FK).',
    retainReason: 'platform config singleton with no user FK per §3A(e)',
  },

  // ── over-limit ──────────────────────────────────────────────────────────────
  {
    collection: 'connect_over_limit_states',
    model: 'ConnectOverLimitState',
    klass: 'own',
    description: "The user's own monetization over-limit episode state.",
    deleteWhereUser: [{ field: 'userId' }],
  },

  // ── boost-nudges ────────────────────────────────────────────────────────────
  {
    collection: 'connect_boost_nudge_shown',
    model: 'ConnectBoostNudgeShown',
    klass: 'own',
    description: "The user's own boost-nudge cooldown markers (TTL).",
    deleteWhereUser: [{ field: 'ownerUserId' }],
  },
  {
    collection: 'connect_boost_nudge_dismissals',
    model: 'ConnectBoostNudgeDismissal',
    klass: 'own',
    description: "The user's own boost-nudge dismissals (TTL).",
    deleteWhereUser: [{ field: 'ownerUserId' }],
  },

  // ── entities ────────────────────────────────────────────────────────────────
  {
    collection: 'connect_company_pages',
    model: 'CompanyPage',
    klass: 'own',
    description: "The user's own company / institute pages.",
    deleteWhereUser: [{ field: 'ownerUserId' }],
    deindexAfter: 'company-page',
  },
  {
    collection: 'connect_storefronts',
    model: 'Storefront',
    klass: 'own',
    description: "The user's own storefronts.",
    deleteWhereUser: [{ field: 'ownerUserId' }],
    deindexAfter: 'storefront',
  },

  // ── ads (the Connect analog of "never purge LedgerEntry" — §3A.d) ────────────
  {
    collection: 'ad_campaigns',
    model: 'AdCampaign',
    klass: 'billing',
    description:
      "The user's own boost campaigns (budget envelope + billing). Rows are RETAINED (billing evidence); the handler only STOPS any in-flight campaign and FORFEITS its unspent reserve (CN-PURGE-1).",
    // CN-PURGE-1: the handler augments the retain-only classification — it does
    // NOT delete rows (klass stays 'billing'), it just transitions in-flight
    // campaigns to completed + forfeits their reserved hold (no refund per OQ-2).
    handler: 'ads-purge',
    retainReason:
      'advertiser billing evidence per §3A(d) (budget/spend ties to the wallet ledger; never individually purged); ownerUserId resolves to the Deleted-user stub after the identity scrub',
  },
  {
    collection: 'ad_sets',
    model: 'AdSet',
    klass: 'billing',
    description: "Targeting spec for the user's campaigns (reached via campaignId).",
    retainReason: 'part of the retained advertiser billing subsystem per §3A(d)',
  },
  {
    collection: 'ad_creatives',
    model: 'AdCreative',
    klass: 'billing',
    description: "Rendered ad units for the user's campaigns + admin review trail.",
    retainReason: 'part of the retained advertiser billing subsystem per §3A(d)',
  },
  {
    collection: 'ad_placements',
    model: 'AdPlacement',
    klass: 'config',
    description: 'Platform-wide ad placement slots (no user FK).',
    retainReason: 'platform config with no user FK per §3A(e)',
  },
  {
    collection: 'ad_advertiser_wallets',
    model: 'AdvertiserWallet',
    klass: 'billing',
    description: "The user's prepaid ad-credit wallet.",
    retainReason: 'advertiser money/wallet evidence per §3A(d); never individually purged',
  },
  {
    collection: 'ad_wallet_ledgers',
    model: 'AdWalletLedger',
    klass: 'billing',
    description: "The append-only signed money trail for the user's ad wallet.",
    retainReason:
      'advertiser money trail per §3A(d) — the Connect analog of "never purge LedgerEntry"',
  },
  {
    collection: 'ad_wallet_topups',
    model: 'AdWalletTopup',
    klass: 'billing',
    description: "Razorpay top-up payment records for the user's ad wallet.",
    retainReason: 'advertiser payment/billing evidence per §3A(d) (8y GST/billing basis)',
  },
  {
    collection: 'ad_impressions',
    model: 'AdImpression',
    klass: 'billing',
    description: "Impressions the user generated against OTHER advertisers' ads (viewer).",
    retainReason: "ad-billing evidence (the user is the viewer of others' ads) per §3A(d)",
  },
  {
    collection: 'ad_clicks',
    model: 'AdClick',
    klass: 'billing',
    description: "Clicks the user generated against OTHER advertisers' ads (viewer).",
    retainReason: "ad-billing evidence (the user is the viewer of others' ads) per §3A(d)",
  },
  {
    collection: 'ad_daily_rollups',
    model: 'AdDailyRollup',
    klass: 'billing',
    description: 'Per-campaign daily performance rollups (no user FK; reached via campaignId).',
    retainReason: 'part of the retained advertiser billing subsystem per §3A(d)',
  },
  {
    collection: 'connect_pricing_configs',
    model: 'ConnectPricingConfig',
    klass: 'config',
    description: 'Platform-wide ad pricing config singleton (no user FK).',
    retainReason: 'platform config singleton with no user FK per §3A(e)',
  },
];

/** Index for O(1) lookup + the completeness gate. */
const BY_COLLECTION = new Map<string, ConnectPurgeEntry>(
  CONNECT_PURGE_MANIFEST.map((e) => [e.collection, e]),
);

/** Manifest entry for a collection, or `undefined` if unclassified. */
export function connectPurgeEntryFor(collection: string): ConnectPurgeEntry | undefined {
  return BY_COLLECTION.get(collection);
}
