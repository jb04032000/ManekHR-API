/**
 * ManekHR Connect -- Inbox (Phase 7, I5b) cold-contact spam scoring.
 *
 * Pure, server-side, SCORED (not binary). It runs on a COLD FIRST CONTACT only
 * (a DM the sender initiated to someone who has not replied yet); replies and
 * consent-based context threads are never scored. The score escalates an action
 * (log -> soft-limit -> auto-quarantine new initiations) but NEVER auto-bans --
 * a false positive on a low-literacy user must be cheap to recover from, so the
 * worst outcome is "cannot start NEW cold chats for a while"; existing
 * conversations and replies always keep working.
 *
 * Weights are tuned so no SINGLE innocent signal can quarantine: a lone phone
 * number or link only reaches `log`. Quarantine needs a genuinely spammy
 * combination (e.g. link + repeated body + high fan-out) or accumulated reports.
 * All numbers are tunable.
 */

export interface SpamSignalInput {
  /** The cold first-contact message body. */
  body: string;
  /** How many times this sender sent this same body recently (Redis-counted). */
  duplicateBodyCount: number;
  /** Cold new-thread initiations by this sender in the recent window. */
  initiationCount: number;
  /** Open abuse reports currently filed against this sender. */
  openReportCount: number;
}

export interface SpamScore {
  score: number;
  signals: string[];
}

const WEIGHTS = {
  link: 2,
  phone: 2,
  email: 1,
  contactWord: 1,
  repeatedBody: 3,
  highFanout: 2,
  reportEach: 2,
};

/** A body repeated this many times reads as a mass-blast. */
const DUPLICATE_THRESHOLD = 3;
/** Cold initiations beyond this in the window read as high fan-out. */
const FANOUT_THRESHOLD = 10;
/** Cap the report contribution so a brigading cluster cannot run the score away. */
const REPORT_CAP = 3;

/** Action thresholds on the cumulative score. */
export const SPAM_THRESHOLDS = { soft: 3, quarantine: 6 } as const;

// Detection patterns. Deliberately simple + high-precision; this is a signal
// contributor, not a verdict.
const LINK_RE = /(https?:\/\/|\bwww\.)/i;
const PHONE_RE = /(?:\+?91[\s-]?)?[6-9]\d{9}\b/;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const CONTACT_WORD_RE = /\b(whats\s?app|wa\.me|telegram|\bt\.me\b)\b/i;

/** Score a cold first-contact message. Pure. */
export function scoreColdContact(input: SpamSignalInput): SpamScore {
  const body = input.body ?? '';
  const signals: string[] = [];
  let score = 0;

  const hasLink = LINK_RE.test(body);
  if (hasLink) {
    score += WEIGHTS.link;
    signals.push('link');
  }
  if (PHONE_RE.test(body)) {
    score += WEIGHTS.phone;
    signals.push('phone');
  }
  if (EMAIL_RE.test(body)) {
    score += WEIGHTS.email;
    signals.push('email');
  }
  // A "whatsapp me" style nudge without an explicit link is still a move to take
  // the lead off-platform on first contact.
  if (!hasLink && CONTACT_WORD_RE.test(body)) {
    score += WEIGHTS.contactWord;
    signals.push('contact_word');
  }
  if (input.duplicateBodyCount >= DUPLICATE_THRESHOLD) {
    score += WEIGHTS.repeatedBody;
    signals.push('repeated_body');
  }
  if (input.initiationCount >= FANOUT_THRESHOLD) {
    score += WEIGHTS.highFanout;
    signals.push('high_fanout');
  }
  if (input.openReportCount > 0) {
    score += WEIGHTS.reportEach * Math.min(input.openReportCount, REPORT_CAP);
    signals.push('reports');
  }

  return { score, signals };
}

export type SpamAction = 'allow' | 'log' | 'soft_limit' | 'quarantine';

/** Map a score to an action. Never returns a ban; quarantine is the ceiling. */
export function decideSpamAction(score: number): SpamAction {
  if (score >= SPAM_THRESHOLDS.quarantine) return 'quarantine';
  if (score >= SPAM_THRESHOLDS.soft) return 'soft_limit';
  if (score > 0) return 'log';
  return 'allow';
}
