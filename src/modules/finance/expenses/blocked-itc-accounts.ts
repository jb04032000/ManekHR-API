/**
 * Section 17(5) blocked-ITC enforcement.
 * Server-side authoritative — clients cannot override these decisions.
 *
 * Two-layer detection:
 *  1. BLOCKED_ITC_ACCOUNT_CODES — exact CoA code match (initially empty;
 *     populated when category-tagging UI ships in Wave 6).
 *  2. BLOCKED_ITC_NAME_PATTERNS — regex match on account name; covers
 *     Section 17(5) categories: motor vehicles ≤13 seats, food/beverage,
 *     club/membership/gym/fitness, beauty/cosmetic, CSR, personal use.
 *
 * Returns true if account is blocked-ITC; service then forces
 * itcEligibility='blocked' regardless of client payload.
 */
export const BLOCKED_ITC_ACCOUNT_CODES = new Set<string>([
  // populated as users tag CoA accounts; intentionally empty for v1
]);

export const BLOCKED_ITC_NAME_PATTERNS: RegExp[] = [
  /club|membership|gym|fitness/i,
  /food|catering|beverage/i,
  /motor\s*vehicle|petrol|diesel|fuel/i,
  /\bcsr\b|corporate\s*social/i,
  /cosmetic|beauty|salon|spa/i,
  /\bpersonal\b/i,
];

export function isBlockedItcAccount(code: string, accountName: string): boolean {
  if (BLOCKED_ITC_ACCOUNT_CODES.has(code)) return true;
  return BLOCKED_ITC_NAME_PATTERNS.some((re) => re.test(accountName));
}
