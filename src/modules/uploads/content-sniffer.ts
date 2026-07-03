/**
 * Content sniffing (magic-byte) validation for uploads.
 *
 * The declared `file.mimetype` is client-controlled — a renamed `.exe` can
 * arrive labelled `image/jpeg`. This module reads the actual leading bytes of
 * the buffer and verifies the real format against the category policy, so the
 * backend never trusts the client's word about what a file is.
 *
 * Links to:
 *  - `upload-policies.ts` — supplies the per-category `UploadPolicy` (the
 *    allowed `mimeTypes` list this sniffer checks the detected type against).
 *  - `uploads.service.ts` — calls `sniffAndCheck` for every upload in both the
 *    quota-aware and legacy paths, before the bytes reach storage.
 *
 * **Why `file-type@16.5.4` (pinned, CommonJS):** file-type >= 17 is ESM-only.
 * This repo compiles to CommonJS (`tsconfig module: commonjs`), where TypeScript
 * downlevels a dynamic `import()` to `require()` — which throws on an ESM-only
 * package. v16 is the last CommonJS release and exposes the same `fromBuffer`
 * detector (including proper OOXML docx/xlsx detection), so a static import is
 * clean and avoids an ESM-interop shim. NestJS declares `file-type@^20` only as
 * an *optional* peer (for its built-in FileTypeValidator, which this repo does
 * not use), so the pin does not break anything at runtime.
 */
import { fromBuffer } from 'file-type';
import type { UploadPolicy } from './upload-policies';

/**
 * Pairs of MIME types that must be treated as matching, never as a spoof.
 * These are real-world container/codec ambiguities, not attacks:
 *  - WebM voice notes frequently sniff as `video/webm` even when the browser
 *    declared `audio/webm` (same container, no video track).
 *  - The MP4 container is shared by audio-only and video payloads, and the
 *    sniffer cannot always tell `audio/mp4` from `video/mp4`.
 *  - QuickTime (`.mov`) and MP4 share the ISO-BMFF base; either label is valid
 *    for the other's bytes.
 *  - `image/jpg` is a common (non-canonical) alias for `image/jpeg`.
 */
const EQUIVALENCE_GROUPS: readonly (readonly string[])[] = [
  ['audio/webm', 'video/webm'],
  ['audio/mp4', 'video/mp4'],
  ['video/quicktime', 'video/mp4'],
  ['image/jpeg', 'image/jpg'],
  // CFB is one shared container for all legacy (pre-2007) Office formats; we
  // cannot distinguish doc/xls/ppt from magic bytes alone, so any CFB file is
  // accepted wherever any legacy Office type is allowed.
  [
    'application/x-cfb',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
  ],
];

/**
 * MIME types that `file-type` legitimately CANNOT detect from magic bytes
 * (they are text / XML based, with no binary signature). When a category
 * policy allows one of these, an undetectable sniff result is expected and we
 * fall back to the declared-mime check instead of rejecting. SVG is XML and
 * has no reliable magic number, so it belongs here too.
 */
const UNDETECTABLE_FRIENDLY = new Set<string>([
  'text/plain',
  'text/csv',
  'text/html',
  'text/xml',
  'application/json',
  'application/xml',
  'image/svg+xml',
]);

export interface SniffViolation {
  reason: 'content-mismatch' | 'content-undetectable';
  message: string;
}

/** Lower-case and strip any `; charset=...` parameter from a MIME string. */
function normalizeMime(mime: string | undefined | null): string {
  if (!mime) return '';
  return mime.split(';')[0].trim().toLowerCase();
}

/** The family segment before the slash, e.g. `image/png` -> `image`. */
function mimeFamily(mime: string): string {
  const i = mime.indexOf('/');
  return i === -1 ? mime : mime.slice(0, i);
}

/** Every MIME type that shares an equivalence group with `mime` (incl. itself). */
function equivalentsOf(mime: string): string[] {
  const out = new Set<string>([mime]);
  for (const group of EQUIVALENCE_GROUPS) {
    if (group.includes(mime)) group.forEach((m) => out.add(m));
  }
  return [...out];
}

/** True when `a` and `b` are the same type or sit in the same equivalence group. */
function areEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  return EQUIVALENCE_GROUPS.some((group) => group.includes(a) && group.includes(b));
}

/** Wildcard-aware single-pattern match, mirroring `checkUploadPolicy`. */
function matchesPattern(pattern: string, mime: string): boolean {
  if (pattern.endsWith('/*')) return mime.startsWith(pattern.slice(0, -1));
  return pattern === mime;
}

/**
 * True when the detected type (or any of its equivalents) is permitted by the
 * policy's allowed `mimeTypes`. Equivalence is applied so a `video/webm` sniff
 * passes a policy that lists `audio/webm`.
 */
function detectedAllowedByPolicy(detected: string, policy: UploadPolicy): boolean {
  const candidates = equivalentsOf(detected);
  return candidates.some((c) => policy.mimeTypes.some((p) => matchesPattern(p, c)));
}

/**
 * True when the policy permits a type that `file-type` cannot detect (text /
 * CSV / SVG / `*` wildcard). Such policies tolerate an undetectable sniff and
 * fall back to the declared-mime guard rather than rejecting outright.
 */
function policyAllowsUndetectable(policy: UploadPolicy): boolean {
  return policy.mimeTypes.some((p) => {
    if (p === '*/*' || p === '*') return true;
    if (p.endsWith('/*')) return p.slice(0, -2) === 'text';
    return UNDETECTABLE_FRIENDLY.has(p);
  });
}

/**
 * Pure decision: given the declared MIME, the detected MIME (or `undefined`
 * when the sniffer could not classify the bytes), and the resolved category
 * policy, return a violation or `null` when the content is acceptable.
 *
 * Rules (in order):
 *  1. Undetectable bytes: reject when the policy is binary-media-only; otherwise
 *     defer to the declared-mime check (current behaviour).
 *  2. Detected type must be in the policy's allowed list (equivalence-aware).
 *  3. Detected and declared must not disagree across format families (e.g.
 *     declared `image/jpeg` but detected `application/x-msdownload`), unless
 *     they are a known equivalent pair.
 */
export function evaluateContent(args: {
  declaredMime: string | undefined | null;
  detectedMime: string | undefined | null;
  policy: UploadPolicy;
}): SniffViolation | null {
  const declared = normalizeMime(args.declaredMime);
  const detected = normalizeMime(args.detectedMime);

  // (1) Undetectable content.
  if (!detected) {
    if (policyAllowsUndetectable(args.policy)) return null;
    return {
      reason: 'content-undetectable',
      message: 'File content could not be verified for this upload.',
    };
  }

  // (2) Detected real type must be allowed by the category policy.
  if (!detectedAllowedByPolicy(detected, args.policy)) {
    return {
      reason: 'content-mismatch',
      message: `File content (${detected}) is not allowed for this upload.`,
    };
  }

  // (3) Declared vs detected cross-family disagreement (declared is already
  //     known-allowed by the upstream policy check). Equivalent pairs (webm
  //     audio/video, mp4 audio/video, quicktime/mp4, jpg/jpeg) are exempt.
  if (
    declared &&
    !areEquivalent(declared, detected) &&
    mimeFamily(declared) !== mimeFamily(detected)
  ) {
    return {
      reason: 'content-mismatch',
      message: `File content (${detected}) does not match the declared type (${declared}).`,
    };
  }

  return null;
}

/**
 * Detect the real MIME type from a buffer's magic bytes. Returns `undefined`
 * when `file-type` cannot classify the content (text, CSV, SVG, or a corrupt
 * header).
 */
export async function detectMime(buffer: Buffer): Promise<string | undefined> {
  const result = await fromBuffer(buffer);
  return result?.mime;
}

/**
 * Sniff the buffer and evaluate it against the policy in one call. Returns a
 * violation or `null`. The single integration point used by the service.
 */
export async function sniffAndCheck(
  buffer: Buffer,
  declaredMime: string | undefined | null,
  policy: UploadPolicy,
): Promise<SniffViolation | null> {
  const detectedMime = await detectMime(buffer);
  return evaluateContent({ declaredMime, detectedMime, policy });
}
