import { describe, it, expect } from 'vitest';
import type { UploadPolicy } from '../upload-policies';
import {
  evaluateAudioDuration,
  evaluateImageDimensions,
  probeAudioDuration,
  probeImageDimensions,
  probeAndCheckAudio,
  probeAndCheckImage,
  MAX_IMAGE_EDGE_PX,
  MAX_IMAGE_MEGAPIXELS,
} from '../media-probe';

/**
 * Media-constraint tests. The decision logic is exercised directly via the pure
 * evaluators; the parser wiring is exercised with REAL, deterministically
 * constructed buffers:
 *  - a WAV header declaring an exact N-second clip (8kHz mono 8-bit => byteRate
 *    8000, so data length = N * 8000 yields exactly N seconds), parsed by
 *    music-metadata;
 *  - a minimal PNG (8-byte signature + IHDR with width/height) read by
 *    image-size from the header alone (no pixel data needed).
 */

/** Build a WAV buffer of exactly `seconds` length (8kHz, mono, 8-bit PCM). */
function wav(seconds: number): Buffer {
  const sampleRate = 8000;
  const channels = 1;
  const bits = 8;
  const byteRate = (sampleRate * channels * bits) / 8; // 8000 bytes/sec
  const dataLen = seconds * byteRate;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE((channels * bits) / 8, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

/** Build a minimal PNG (signature + IHDR) declaring `w` x `h`. */
function png(w: number, h: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); // IHDR length
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  ihdr.writeUInt8(8, 16); // bit depth
  ihdr.writeUInt8(2, 17); // color type (truecolor)
  return Buffer.concat([sig, ihdr]);
}

// Inline policy fixtures (the Connect categories that used to carry these
// constraints were removed; the probe machinery is category-agnostic and only
// reads `duration.max` + `image.aspectRatio` off the policy shape).
const MB = 1024 * 1024;
const AUDIO_POLICY: UploadPolicy = {
  maxBytes: 10 * MB,
  mimeTypes: ['audio/webm', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav'],
  duration: { max: 180 }, // duration cap 180
};
const BANNER_POLICY: UploadPolicy = {
  maxBytes: 5 * MB,
  mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  image: { aspectRatio: { ratio: 4, tolerance: 0.6 } }, // 4:1 tol 0.6
};
const PORTFOLIO_POLICY: UploadPolicy = {
  maxBytes: 5 * MB,
  mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
}; // image, no aspect cap, no duration cap

// ── Audio duration (real parser) ──────────────────────────────────────────

describe('audio duration enforcement', () => {
  it('rejects a 200s clip (over the 180s cap)', async () => {
    const { violation, durationSec } = await probeAndCheckAudio(
      wav(200),
      'audio/wav',
      AUDIO_POLICY,
    );
    expect(durationSec).toBe(200);
    expect(violation?.reason).toBe('duration');
  });

  it('accepts a 170s clip (under the cap)', async () => {
    const { violation, durationSec } = await probeAndCheckAudio(
      wav(170),
      'audio/wav',
      AUDIO_POLICY,
    );
    expect(durationSec).toBe(170);
    expect(violation).toBeNull();
  });

  it('accepts a clip exactly at the cap + tolerance (180s)', async () => {
    const { violation } = await probeAndCheckAudio(wav(180), 'audio/wav', AUDIO_POLICY);
    expect(violation).toBeNull();
  });

  it('probes the real duration from the header', async () => {
    expect(await probeAudioDuration(wav(42), 'audio/wav')).toBe(42);
  });

  it('fails closed when the parser cannot determine duration (capped category)', () => {
    // A valid-but-unparseable-duration audio file (e.g. an mp3 with no usable
    // header timing) yields `undefined`; a duration-capped category must reject.
    expect(evaluateAudioDuration({ durationSec: undefined, policy: AUDIO_POLICY })?.reason).toBe(
      'duration',
    );
  });

  it('rejects a garbage audio buffer under a capped category (fail closed end to end)', async () => {
    const garbage = Buffer.from('not real audio bytes at all', 'utf8');
    const { violation } = await probeAndCheckAudio(garbage, 'audio/mpeg', AUDIO_POLICY);
    expect(violation?.reason).toBe('duration');
  });
});

// ── Image dimensions (real header read) ─────────────────────────────────────

describe('image dimension enforcement', () => {
  it('reads width/height from the PNG header', () => {
    expect(probeImageDimensions(png(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('rejects an image with an edge over 8000px', () => {
    expect(probeAndCheckImage(png(9000, 100), PORTFOLIO_POLICY)?.reason).toBe('image-dimensions');
  });

  it('rejects a 60-megapixel image (decompression-bomb guard)', () => {
    // 8000x7500 = 60MP: within the 8000px edge cap, over the 50MP cap, so this
    // isolates the megapixel guard from the edge guard.
    expect(8000 * 7500).toBeGreaterThan(MAX_IMAGE_MEGAPIXELS * 1_000_000);
    expect(8000).toBeLessThanOrEqual(MAX_IMAGE_EDGE_PX);
    expect(probeAndCheckImage(png(8000, 7500), PORTFOLIO_POLICY)?.reason).toBe('image-dimensions');
  });

  it('accepts a normal photo', () => {
    expect(probeAndCheckImage(png(1920, 1080), PORTFOLIO_POLICY)).toBeNull();
  });

  it('rejects an unreadable / corrupt image header', () => {
    expect(
      probeAndCheckImage(Buffer.from('definitely not a png', 'utf8'), PORTFOLIO_POLICY)?.reason,
    ).toBe('image-unreadable');
  });
});

// ── Banner aspect ratio (4:1, tolerance 0.6 -> band 1.6 .. 6.4) ──────────────

describe('banner aspect-ratio enforcement', () => {
  it('accepts a banner inside the tolerance band (4:1)', () => {
    expect(probeAndCheckImage(png(1600, 400), BANNER_POLICY)).toBeNull();
  });

  it('accepts the lower edge of the band (~1.6:1)', () => {
    expect(probeAndCheckImage(png(1600, 1000), BANNER_POLICY)).toBeNull();
  });

  it('rejects a near-square banner (1:1, well outside the band)', () => {
    expect(probeAndCheckImage(png(1000, 1000), BANNER_POLICY)?.reason).toBe('image-aspect');
  });

  it('rejects an over-wide banner (8:1, outside the band)', () => {
    // 8000x1000 = 8:1; edge cap ok (8000), megapixel ok (8MP), so the aspect
    // guard is what fires.
    expect(probeAndCheckImage(png(8000, 1000), BANNER_POLICY)?.reason).toBe('image-aspect');
  });
});

// ── Pure evaluator edge cases ───────────────────────────────────────────────

describe('evaluators', () => {
  it('passes audio through when the category has no duration cap', () => {
    // Use a genuinely uncapped image policy here.
    expect(
      evaluateAudioDuration({
        durationSec: 9999,
        policy: PORTFOLIO_POLICY,
      }),
    ).toBeNull();
  });

  it('rejects a missing image header as unreadable', () => {
    expect(evaluateImageDimensions({ dims: undefined, policy: PORTFOLIO_POLICY })?.reason).toBe(
      'image-unreadable',
    );
  });
});
