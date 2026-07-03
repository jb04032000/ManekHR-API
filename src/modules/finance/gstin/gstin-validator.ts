// Offline GSTIN validation: 15-char format + valid GST state code + the GSTN mod-36
// check digit (catches transposition/typo errors that the format regex alone passes).
// No network or provider needed, so it can gate party/firm GSTIN entry for free before
// the paid lookup (GstinService.lookup) is ever called. Cross-link: gstin.service.ts
// (lookup uses this), gstin.controller.ts (free /validate endpoint).
//
// Algorithm (plan §5 / GSTN spec, verified against 27AAPFU0939F1ZV -> 'V'):
//   map each of the first 14 chars to base-36 (0-9, A-Z = 0..35); multiply by an
//   alternating 1,2,1,2... factor (index 0 = x1); sum floor(p/36)+(p%36) per product;
//   check = (36 - sum%36) % 36, re-encoded to base-36; it must equal the 15th char.

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Valid GST state / UT codes (01-38). Keep in sync with the official GST state-code list;
// 38 = Ladakh (added 2019), 26/27 etc. are existing states (Gujarat = 24).
const VALID_STATE_CODES = new Set(
  Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, '0')),
);

export type GstinInvalidReason = 'format' | 'state_code' | 'check_digit';

export interface GstinValidation {
  valid: boolean;
  stateCode?: string;
  reason?: GstinInvalidReason;
}

/** The GSTN check digit (15th char) for a 14-char GSTIN prefix. */
export function gstinCheckDigit(first14: string): string {
  let sum = 0;
  for (let i = 0; i < first14.length; i++) {
    const code = CHARSET.indexOf(first14[i]);
    const factor = i % 2 === 0 ? 1 : 2;
    const product = code * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  const checkCode = (36 - (sum % 36)) % 36;
  return CHARSET[checkCode];
}

/** Validate a GSTIN fully offline: format, state code, and check digit. */
export function validateGstin(gstin: string): GstinValidation {
  const raw = gstin ?? '';
  // D16: a GSTIN is exactly 15 chars; reject anything absurdly long up front so a multi-MB
  // query value on the free /validate endpoint is never trimmed/upper-cased.
  if (raw.length > 20) return { valid: false, reason: 'format' };
  const value = raw.trim().toUpperCase();
  if (!GSTIN_REGEX.test(value)) return { valid: false, reason: 'format' };
  const stateCode = value.slice(0, 2);
  if (!VALID_STATE_CODES.has(stateCode)) return { valid: false, stateCode, reason: 'state_code' };
  if (gstinCheckDigit(value.slice(0, 14)) !== value[14]) {
    return { valid: false, stateCode, reason: 'check_digit' };
  }
  return { valid: true, stateCode };
}

/** Convenience boolean form. */
export function isValidGstin(gstin: string): boolean {
  return validateGstin(gstin).valid;
}
