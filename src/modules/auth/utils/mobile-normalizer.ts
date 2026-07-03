/**
 * SMS-OTP feature is India-only (+91). Accepts a wide range of paste/typed
 * formats and normalises to a canonical 12-digit form (`91` country code +
 * 10-digit Indian mobile). Validates the 10-digit body starts with 6/7/8/9
 * (TRAI-allocated mobile prefixes).
 *
 * Mirrors the logic of `normaliseMobileForMsg91()` in sms.service.ts but adds
 * Indian-format validation; the SMS-service helper stays generic for future
 * non-IN sends (e.g. ops alerts).
 */

const INDIAN_MOBILE_RE = /^[6-9]\d{9}$/;

export interface NormalisedMobile {
  /** Full E.164-style without `+`, e.g. "919876543210". */
  full: string;
  /** Bare 10-digit body, e.g. "9876543210". */
  bare: string;
  /** Last 4 digits — convenient for masked UI copy. */
  last4: string;
}

/**
 * Strip non-digits, strip the `91`/`091` prefix, and return the 10-digit body
 * + the canonical full form. Returns `null` when the input cannot be coerced
 * into a valid Indian mobile.
 */
export function normaliseIndianMobile(input: string): NormalisedMobile | null {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, '');
  let bare: string | null = null;
  if (digits.length === 10) {
    bare = digits;
  } else if (digits.length === 12 && digits.startsWith('91')) {
    bare = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    bare = digits.slice(1);
  } else if (digits.length === 13 && digits.startsWith('091')) {
    bare = digits.slice(3);
  }
  if (!bare || !INDIAN_MOBILE_RE.test(bare)) return null;
  return {
    full: `91${bare}`,
    bare,
    last4: bare.slice(-4),
  };
}

/**
 * Canonical 12-digit Indian-mobile regex — matches what `normaliseIndianMobile`
 * outputs for `.full`. Use as the `@Matches` pattern AFTER applying
 * `transformMobile` in a class-validator DTO. Single source of truth so the
 * SMS-OTP DTOs and any other module that accepts an Indian mobile (team,
 * etc.) share one rule.
 */
export const FULL_INDIAN_RE = /^91[6-9]\d{9}$/;

/**
 * `class-transformer` `@Transform` adapter — coerces an inbound mobile string
 * into the canonical `91XXXXXXXXXX` form so `@Matches(FULL_INDIAN_RE)` can
 * match. If the input cannot be parsed as an Indian mobile we leave the
 * original (trimmed) value so the user sees a clear validation error rather
 * than an empty/garbage one.
 */
export function transformMobile({ value }: { value: unknown }): string {
  if (typeof value !== 'string') return '';
  const norm = normaliseIndianMobile(value);
  return norm ? norm.full : value.trim();
}

/**
 * Mask everything except the last 4 digits — used in audit logs and
 * user-facing "OTP sent to XX...XX1234" copy.
 */
export function maskIndianMobile(full: string): string {
  if (!full) return '***';
  const cleaned = full.replace(/\D/g, '');
  const last4 = cleaned.slice(-4);
  if (cleaned.length === 12) return `91XXXXXX${last4}`;
  if (cleaned.length === 10) return `XXXXXX${last4}`;
  return `${'X'.repeat(Math.max(0, cleaned.length - 4))}${last4}`;
}
