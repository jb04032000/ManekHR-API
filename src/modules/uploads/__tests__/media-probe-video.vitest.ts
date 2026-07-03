import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Video-duration enforcement tests (feed cap 120s on `connect-posts`).
 *
 * Why music-metadata is mocked here (unlike the audio/image tests, which use
 * real, hand-built WAV/PNG headers): music-metadata@7 derives a video's
 * duration from the track media header (`mdhd`) inside a COMPLETE
 * `moov > trak > mdia > minf > stbl` atom tree, and it crashes on a partial
 * one - so a synthetic byte buffer cannot exercise the real container parse the
 * way `wav()` can for audio. We therefore mock the third-party container reader
 * (`parseBuffer`) and test exactly what is OURS:
 *  - the duration-cap decision (`evaluateVideoDuration`),
 *  - fail-closed behaviour when the duration cannot be read,
 *  - and the `.mov` routing fix: QuickTime is fed to music-metadata's mp4 parser
 *    via a `video/mp4` MIME hint, because music-metadata has NO QuickTime parser
 *    and THROWS "Guessed MIME-type not supported: video/quicktime" on a raw
 *    `.mov` content-detect (verified empirically, 2026-06-11).
 *
 * The real end-to-end mp4/mov/webm parse is covered by a live-file smoke (a real
 * container has the full atom tree music-metadata needs).
 */

const parseBuffer = vi.fn();
vi.mock('music-metadata', () => ({ parseBuffer: (...a: unknown[]) => parseBuffer(...a) }));

// image-size is only used by the image probe; stub it so importing media-probe
// never touches the real module in this video-focused suite.
vi.mock('image-size', () => ({ imageSize: () => undefined }));

import { resolveUploadPolicy } from '../upload-policies';
import { evaluateVideoDuration, probeVideoDuration, probeAndCheckVideo } from '../media-probe';

const POSTS_POLICY = resolveUploadPolicy('connect-posts'); // feed: video cap 120s
const PRODUCT_POLICY = resolveUploadPolicy('connect-product-video'); // marketplace: cap 60s
const PORTFOLIO_POLICY = resolveUploadPolicy('connect-portfolio'); // image-only, no cap
const buf = Buffer.from('pretend this is a real video container');

beforeEach(() => {
  parseBuffer.mockReset();
});

// ── Pure cap decision (no parser) ───────────────────────────────────────────

describe('evaluateVideoDuration', () => {
  it('rejects a clip over the cap (+tolerance)', () => {
    expect(evaluateVideoDuration({ durationSec: 150, policy: POSTS_POLICY })?.reason).toBe(
      'duration',
    );
  });

  it('accepts a clip under the cap', () => {
    expect(evaluateVideoDuration({ durationSec: 110, policy: POSTS_POLICY })).toBeNull();
  });

  it('fails closed when the duration is unknown under a capped category', () => {
    expect(evaluateVideoDuration({ durationSec: undefined, policy: POSTS_POLICY })?.reason).toBe(
      'duration',
    );
  });

  it('passes through when the category has no duration cap', () => {
    expect(evaluateVideoDuration({ durationSec: 9999, policy: PORTFOLIO_POLICY })).toBeNull();
  });
});

// ── Parser routing (the .mov fix) ───────────────────────────────────────────

describe('probeVideoDuration routing', () => {
  it('routes a QuickTime .mov through the mp4 parser (video/mp4 hint)', async () => {
    parseBuffer.mockResolvedValue({ format: { duration: 95 } });

    const d = await probeVideoDuration(buf, 'video/quicktime');

    expect(d).toBe(95);
    // The crux of the .mov support: music-metadata is asked for the mp4 parser,
    // never handed the unsupported video/quicktime type.
    expect(parseBuffer).toHaveBeenCalledWith(buf, { mimeType: 'video/mp4' }, { duration: true });
  });

  it('routes webm to the matroska parser', async () => {
    parseBuffer.mockResolvedValue({ format: { duration: 12 } });
    await probeVideoDuration(buf, 'video/webm');
    expect(parseBuffer).toHaveBeenCalledWith(buf, { mimeType: 'video/webm' }, { duration: true });
  });

  it('returns undefined when the parser throws (corrupt / unsupported)', async () => {
    parseBuffer.mockRejectedValue(new Error('Guessed MIME-type not supported: video/quicktime'));
    expect(await probeVideoDuration(buf, 'video/quicktime')).toBeUndefined();
  });

  it('returns undefined when the parser reports no duration', async () => {
    parseBuffer.mockResolvedValue({ format: {} });
    expect(await probeVideoDuration(buf, 'video/mp4')).toBeUndefined();
  });
});

// ── End-to-end cap enforcement (probe + evaluate) ───────────────────────────

describe('probeAndCheckVideo (feed cap 120)', () => {
  it('rejects a 150s mp4', async () => {
    parseBuffer.mockResolvedValue({ format: { duration: 150 } });
    const { violation, durationSec } = await probeAndCheckVideo(buf, 'video/mp4', POSTS_POLICY);
    expect(durationSec).toBe(150);
    expect(violation?.reason).toBe('duration');
  });

  it('accepts a 110s mp4', async () => {
    parseBuffer.mockResolvedValue({ format: { duration: 110 } });
    const { violation, durationSec } = await probeAndCheckVideo(buf, 'video/mp4', POSTS_POLICY);
    expect(durationSec).toBe(110);
    expect(violation).toBeNull();
  });

  it('parses a .mov duration and accepts it when under the cap', async () => {
    parseBuffer.mockResolvedValue({ format: { duration: 95 } });
    const { violation, durationSec } = await probeAndCheckVideo(
      buf,
      'video/quicktime',
      POSTS_POLICY,
    );
    expect(durationSec).toBe(95);
    expect(violation).toBeNull();
  });

  it('rejects an unparseable video (fail closed)', async () => {
    parseBuffer.mockRejectedValue(new Error('bad container'));
    const { violation, durationSec } = await probeAndCheckVideo(buf, 'video/mp4', POSTS_POLICY);
    expect(durationSec).toBeNull();
    expect(violation?.reason).toBe('duration');
  });
});

describe('probeAndCheckVideo (marketplace product cap 60)', () => {
  it('has a 60s product clip cap on the connect-product-video category', () => {
    expect(PRODUCT_POLICY.duration?.max).toBe(60);
  });

  it('accepts a 45s product clip', async () => {
    parseBuffer.mockResolvedValue({ format: { duration: 45 } });
    const { violation, durationSec } = await probeAndCheckVideo(buf, 'video/mp4', PRODUCT_POLICY);
    expect(durationSec).toBe(45);
    expect(violation).toBeNull();
  });

  it('rejects a 90s product clip (over the 60s cap)', async () => {
    parseBuffer.mockResolvedValue({ format: { duration: 90 } });
    const { violation, durationSec } = await probeAndCheckVideo(buf, 'video/mp4', PRODUCT_POLICY);
    expect(durationSec).toBe(90);
    expect(violation?.reason).toBe('duration');
  });
});
