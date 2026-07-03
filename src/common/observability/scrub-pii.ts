/**
 * PII redaction for Sentry events (launch security — Workstream F). The product
 * stores PAN / Aadhaar / bank / statutory data; DPDP + plain duty of care mean an
 * error report must never carry that to a third-party service. Wired into the
 * Sentry `beforeSend` hook on both the backend (instrument.ts) and web.
 *
 * Strategy (defence in depth, deliberately over-redacts):
 *   1. Values under a sensitive KEY name (password/token/pan/aadhaar/bank/…) are
 *      replaced wholesale.
 *   2. Any STRING value containing a PAN- or Aadhaar-shaped token has that token
 *      masked, wherever it appears (error messages, breadcrumbs, free text).
 * Recurses objects/arrays with a depth cap and a cycle guard so a self-referential
 * Sentry event (they happen) can never throw or loop here.
 *
 * Pure + side-effect-free (returns a redacted clone) so it is unit-testable in
 * isolation; the SDK hooks just call it.
 */

const REDACTED = '[redacted]';
const REDACTED_ID = '[redacted-id]';
const MAX_DEPTH = 8;

// Key names whose VALUE is sensitive regardless of content. Substring, lower-cased.
const SENSITIVE_KEY_PARTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'otp',
  'pan',
  'aadhaar',
  'aadhar',
  'bankaccount',
  'accountnumber',
  'accountno',
  'ifsc',
  'cvv',
  'apikey',
  'api_key',
  'privatekey',
];

// PAN: 5 letters, 4 digits, 1 letter. Aadhaar: 12 digits, optionally 4-4-4 spaced.
const PAN_RE = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi;
const AADHAAR_RE = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => k.includes(part));
}

function scrubString(value: string): string {
  return value.replace(PAN_RE, REDACTED_ID).replace(AADHAAR_RE, REDACTED_ID);
}

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(val, depth + 1, seen);
  }
  return out;
}

/** Return a redacted deep clone of `value` (objects/arrays/strings scanned). */
export function redactPii(value: unknown): unknown {
  return redact(value, 0, new WeakSet());
}
