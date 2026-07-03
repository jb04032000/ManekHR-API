/**
 * Media-constraint validation for uploads -- audio duration + image dimensions.
 *
 * Runs ALONGSIDE the magic-byte content sniffer (`content-sniffer.ts`), not in
 * place of it: the sniffer proves WHAT the file is, this module proves the file
 * sits within the category's duration / dimension limits. Both run in
 * `uploads.service` before the bytes reach storage, so an over-long clip or a
 * decompression-bomb image never lands regardless of what the client claimed.
 *
 * Links to:
 *  - `upload-policies.ts` -- supplies `policy.duration.max` (audio cap, seconds)
 *    and `policy.image.aspectRatio` (banner shape). The image edge / megapixel
 *    ceilings are global safety constants defined here.
 *  - `uploads.service.ts` -- calls `probeAndCheckAudio` / `probeAndCheckImage`.
 *    The parsed audio duration it returns is persisted on the `UploadEvent` and
 *    later OVERRIDES the client-claimed duration on feed / inbox voice notes
 *    (see `media-ownership.service.ts` `getServerAudioDurationByUrl`).
 *
 * **Why `music-metadata@7` (pinned, CommonJS):** music-metadata >= 8 is
 * ESM-only. This repo compiles to CommonJS (`tsconfig module: commonjs`), where
 * TypeScript downlevels a dynamic `import()` to `require()` -- which throws on
 * an ESM-only package. v7 is the last CommonJS line and exposes `parseBuffer`,
 * which reads duration from webm/opus, mp3, m4a/mp4, ogg and wav HEADERS
 * without decoding the audio. This mirrors the same ESM constraint that pins
 * `file-type@16` in `content-sniffer.ts`.
 *
 * **Why `image-size@1` (pinned, CommonJS):** image-size v2 is ESM-only; v1 is
 * the last CommonJS line. It reads width/height from the image HEADER only -- no
 * pixel decode, no native dependency (so no `sharp`) -- which is exactly the
 * cheap dimension read the decompression-bomb guard needs.
 */
import { parseBuffer } from 'music-metadata';
import { imageSize } from 'image-size';
import type { UploadPolicy } from './upload-policies';

/**
 * Decompression-bomb guard ceilings. **Tunable.** An 8000px edge + 50MP cap
 * rejects pathological images (a 100k x 100k PNG is a few header bytes but would
 * allocate gigabytes if ever decoded downstream) while clearing every real
 * photo -- a 48MP phone camera shot (~8000x6000 = 48MP) passes both gates.
 */
export const MAX_IMAGE_EDGE_PX = 8000;
export const MAX_IMAGE_MEGAPIXELS = 50;

/**
 * Audio-duration slack. A clip can sniff a hair over the cap because container
 * timing rounds up; allow 2s before rejecting so a "180s" recording is not
 * bounced for being 180.4s. **Tunable.**
 */
export const DURATION_TOLERANCE_SEC = 2;

export interface MediaViolation {
  reason: 'duration' | 'image-dimensions' | 'image-unreadable' | 'image-aspect';
  message: string;
}

/** Lower-case and strip any `; codecs=...` parameter from a MIME string. */
function normalizeMime(mime: string | undefined | null): string {
  if (!mime) return '';
  return mime.split(';')[0].trim().toLowerCase();
}

/* ── Pure evaluators (decision logic; unit-tested directly) ───────────────── */

/**
 * Decide a clip (audio OR video) against the category's duration cap. `label`
 * just personalises the user-facing message ("Audio" / "Video").
 *
 * Fail closed: a duration-capped category MUST yield a parseable duration. If
 * the parser cannot determine it for an otherwise-valid media file we cannot
 * prove the clip is within the cap, so we reject rather than trust an unknown
 * length. Categories with no `duration` policy pass through untouched.
 */
function evaluateDuration(args: {
  durationSec: number | undefined;
  policy: UploadPolicy;
  label: 'Audio' | 'Video';
}): MediaViolation | null {
  const max = args.policy.duration?.max;
  if (max === undefined) return null; // no duration cap on this category

  if (args.durationSec === undefined || !Number.isFinite(args.durationSec)) {
    return {
      reason: 'duration',
      message: `${args.label} length could not be verified; clips must be ${max} seconds or shorter.`,
    };
  }
  if (args.durationSec > max + DURATION_TOLERANCE_SEC) {
    return {
      reason: 'duration',
      message: `${args.label} is too long (${Math.round(args.durationSec)}s). The limit is ${max} seconds.`,
    };
  }
  return null;
}

/** Decide an audio clip against the category's duration cap (see `evaluateDuration`). */
export function evaluateAudioDuration(args: {
  durationSec: number | undefined;
  policy: UploadPolicy;
}): MediaViolation | null {
  return evaluateDuration({ ...args, label: 'Audio' });
}

/**
 * Decide a video clip against the category's duration cap (see
 * `evaluateDuration`). Same fail-closed semantics as audio: a duration-capped
 * category with an unparseable video duration is rejected. Drives the feed
 * video cap (`connect-posts` -> `duration.max` 120s).
 */
export function evaluateVideoDuration(args: {
  durationSec: number | undefined;
  policy: UploadPolicy;
}): MediaViolation | null {
  return evaluateDuration({ ...args, label: 'Video' });
}

/**
 * Decide an image against the dimension ceilings + (optional) aspect-ratio
 * policy. A detected image whose header cannot be read is treated as corrupt
 * and rejected.
 *
 * Aspect-ratio band mirrors the FE policy semantics documented in
 * `upload-policies.ts`: acceptable `width/height` lies in
 * `[ratio*(1-tolerance), ratio*(1+tolerance)]` (e.g. a 4:1 banner with
 * tolerance 0.6 accepts 1.6:1 through 6.4:1).
 */
export function evaluateImageDimensions(args: {
  dims: { width: number; height: number } | undefined;
  policy: UploadPolicy;
}): MediaViolation | null {
  if (!args.dims || !args.dims.width || !args.dims.height) {
    return {
      reason: 'image-unreadable',
      message: 'Image could not be read for this upload.',
    };
  }

  const { width, height } = args.dims;

  if (width > MAX_IMAGE_EDGE_PX || height > MAX_IMAGE_EDGE_PX) {
    return {
      reason: 'image-dimensions',
      message: `Image is too large (max ${MAX_IMAGE_EDGE_PX}px on either side).`,
    };
  }

  const megapixels = (width * height) / 1_000_000;
  if (megapixels > MAX_IMAGE_MEGAPIXELS) {
    return {
      reason: 'image-dimensions',
      message: `Image resolution is too high (max ${MAX_IMAGE_MEGAPIXELS} megapixels).`,
    };
  }

  const ar = args.policy.image?.aspectRatio;
  if (ar) {
    const actual = width / height;
    const lo = ar.ratio * (1 - ar.tolerance);
    const hi = ar.ratio * (1 + ar.tolerance);
    if (actual < lo || actual > hi) {
      return {
        reason: 'image-aspect',
        message: `Image shape is off; expected close to ${ar.ratio}:1 for this upload.`,
      };
    }
  }

  return null;
}

/* ── Probes (real parser integration) ─────────────────────────────────────── */

/**
 * Read the real duration (seconds) from an audio buffer's header. Returns
 * `undefined` when the parser cannot determine it (corrupt / unsupported) --
 * the evaluator then fails closed for duration-capped categories.
 */
export async function probeAudioDuration(
  buffer: Buffer,
  declaredMime?: string | null,
): Promise<number | undefined> {
  try {
    const mime = normalizeMime(declaredMime);
    const meta = await parseBuffer(buffer, mime ? { mimeType: mime } : undefined, {
      duration: true,
    });
    const d = meta.format.duration;
    return typeof d === 'number' && Number.isFinite(d) ? d : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read width/height from an image buffer's header (no pixel decode). Returns
 * `undefined` on a corrupt / unreadable header, which the evaluator rejects.
 */
/**
 * Read the real duration (seconds) from a VIDEO buffer's header. Returns
 * `undefined` when the parser cannot determine it (corrupt / unsupported) --
 * the evaluator then fails closed for duration-capped categories.
 *
 * `music-metadata@7` reads the container header without decoding frames, but it
 * has NO dedicated QuickTime parser: handed a `.mov` it content-detects
 * `video/quicktime` and THROWS "Guessed MIME-type not supported". A `.mov` is an
 * ISO-BMFF file though (same `ftyp`/`moov`/`trak` atoms as `.mp4`), so we force
 * it through the mp4 parser by passing a `video/mp4` MIME hint. The mapping:
 *  - `video/quicktime` (.mov) -> hint `video/mp4` (route to the mp4 parser);
 *  - `video/mp4` (.mp4)       -> hint `video/mp4`;
 *  - `video/webm` (.webm)     -> hint `video/webm` (Matroska/EBML parser);
 *  - anything else            -> no hint (let music-metadata content-detect).
 *
 * Duration comes from the track media header (`mdhd`) the container parser
 * reads; we never decode frames. The declared MIME is trustworthy here because
 * `content-sniffer` has already verified declared-vs-detected before this runs.
 */
const VIDEO_MIME_HINT: Record<string, string> = {
  'video/quicktime': 'video/mp4',
  'video/mp4': 'video/mp4',
  'video/webm': 'video/webm',
};

export async function probeVideoDuration(
  buffer: Buffer,
  declaredMime?: string | null,
): Promise<number | undefined> {
  try {
    const hint = VIDEO_MIME_HINT[normalizeMime(declaredMime)];
    const meta = await parseBuffer(buffer, hint ? { mimeType: hint } : undefined, {
      duration: true,
    });
    const d = meta.format.duration;
    return typeof d === 'number' && Number.isFinite(d) ? d : undefined;
  } catch {
    return undefined;
  }
}

export function probeImageDimensions(
  buffer: Buffer,
): { width: number; height: number } | undefined {
  try {
    const r = imageSize(buffer);
    if (r && typeof r.width === 'number' && typeof r.height === 'number') {
      return { width: r.width, height: r.height };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/* ── Combined check helpers (the service integration points) ──────────────── */

/**
 * Probe + evaluate an audio buffer in one call. Returns the violation (or null)
 * AND the parsed duration so the caller can persist the server-derived value.
 */
export async function probeAndCheckAudio(
  buffer: Buffer,
  declaredMime: string | undefined | null,
  policy: UploadPolicy,
): Promise<{ violation: MediaViolation | null; durationSec: number | null }> {
  const durationSec = await probeAudioDuration(buffer, declaredMime);
  const violation = evaluateAudioDuration({ durationSec, policy });
  return { violation, durationSec: durationSec ?? null };
}

/**
 * Probe + evaluate a VIDEO buffer in one call. Mirrors `probeAndCheckAudio`:
 * returns the violation (or null) AND the parsed duration so the caller can
 * persist the server-derived value (the feed video duration is stored on the
 * `UploadEvent` like audio is, then copied onto the post media item).
 */
export async function probeAndCheckVideo(
  buffer: Buffer,
  declaredMime: string | undefined | null,
  policy: UploadPolicy,
): Promise<{ violation: MediaViolation | null; durationSec: number | null }> {
  const durationSec = await probeVideoDuration(buffer, declaredMime);
  const violation = evaluateVideoDuration({ durationSec, policy });
  return { violation, durationSec: durationSec ?? null };
}

/** Probe + evaluate an image buffer in one call. */
export function probeAndCheckImage(buffer: Buffer, policy: UploadPolicy): MediaViolation | null {
  const dims = probeImageDimensions(buffer);
  return evaluateImageDimensions({ dims, policy });
}
