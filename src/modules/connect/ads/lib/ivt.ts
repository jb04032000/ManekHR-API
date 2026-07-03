/**
 * ManekHR Connect Ads -- basic invalid-traffic (IVT) heuristics.
 *
 * Pure, dependency-free click-validity classifier used by AdEventsService.recordClick.
 * Heuristics only (no ML, no external IVT service): the four rules below catch the
 * obvious junk -- self-clicks, rapid duplicates, bot user-agents, and per-day
 * hammering -- so they are RECORDED for the audit trail but never billed.
 *
 * Links to:
 *  - ad-events.service.ts (recordClick) -- gathers the signals and calls classifyClick;
 *    an invalid verdict stores the click with its reason but skips the claim-first debit.
 *  - ad-click.schema.ts -- persists `valid` + `invalidReason` (audit trail + future tuning).
 *
 * Gotcha: the same-impression duplicate is ALREADY blocked at the DB level by the
 * unique `impressionToken` index on ad_clicks (createIfAbsent returns false). The
 * `rapid_duplicate` rule here is the COMPLEMENTARY guard against the same user
 * rapidly clicking *different* impressions of the SAME campaign within the window.
 */

/** Dedupe window: a second click by the same user on the same campaign inside
 *  this window is treated as a rapid duplicate (recorded, not charged). ~10 min. */
export const IVT_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/** Daily cap: more than this many clicks by one user on one campaign in 24h is
 *  abuse -- everything past the cap is recorded but not charged. */
export const IVT_DAILY_CLICK_CAP = 10;

/** Rolling window for the daily cap. 24h. */
export const IVT_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Small denylist of obvious bot / non-browser user-agent substrings (lower-cased
 * match). Not exhaustive by design -- catches the obvious automated traffic that
 * should never bill an advertiser. A missing/empty UA is treated as bot-typical.
 */
export const IVT_BOT_UA_SUBSTRINGS: readonly string[] = [
  'bot',
  'crawler',
  'spider',
  'scrapy',
  'curl',
  'wget',
  'python-requests',
  'python-urllib',
  'go-http-client',
  'java/',
  'okhttp',
  'headless',
  'phantomjs',
  'slurp',
  'http-client',
  'libwww',
  'httpunit',
];

/** Reason an automated/abusive click was invalidated. Stored on the click row. */
export type IvtReason = 'self_click' | 'bot_ua' | 'rapid_duplicate' | 'daily_cap';

export interface ClickSignals {
  /** The user performing the click (JWT subject). */
  clickerUserId: string;
  /** The advertiser who owns the clicked campaign. */
  ownerUserId: string;
  /** Raw request user-agent header (may be absent). */
  userAgent?: string | null;
  /** Prior clicks by this user on this campaign within IVT_DEDUPE_WINDOW_MS. */
  recentClickCount: number;
  /** Clicks by this user on this campaign within IVT_DAILY_WINDOW_MS. */
  dailyClickCount: number;
}

export interface IvtVerdict {
  valid: boolean;
  reason?: IvtReason;
}

/** True when the user-agent is missing or matches an obvious bot substring. */
export function isBotUserAgent(userAgent?: string | null): boolean {
  if (!userAgent || userAgent.trim().length === 0) return true;
  const ua = userAgent.toLowerCase();
  return IVT_BOT_UA_SUBSTRINGS.some((sub) => ua.includes(sub));
}

/**
 * Classify a click as valid or invalid using the four heuristics, in precedence
 * order (first match wins): self-click, bot UA, rapid duplicate, daily cap.
 *
 * `dailyClickCount` / `recentClickCount` count PRIOR clicks (this click excluded),
 * so the (N+1)th click past the cap is the first to be invalidated.
 */
export function classifyClick(s: ClickSignals): IvtVerdict {
  // a. Self-click: advertiser clicking their own ad never bills.
  if (s.clickerUserId && s.clickerUserId === s.ownerUserId) {
    return { valid: false, reason: 'self_click' };
  }

  // c. Obvious bot / non-browser agent (or missing UA).
  if (isBotUserAgent(s.userAgent)) {
    return { valid: false, reason: 'bot_ua' };
  }

  // b. Rapid duplicate: a prior click on this campaign by this user inside the window.
  if (s.recentClickCount >= 1) {
    return { valid: false, reason: 'rapid_duplicate' };
  }

  // d. Daily cap: more than IVT_DAILY_CLICK_CAP clicks on this campaign in 24h.
  if (s.dailyClickCount >= IVT_DAILY_CLICK_CAP) {
    return { valid: false, reason: 'daily_cap' };
  }

  return { valid: true };
}
